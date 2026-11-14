import { type Static, Type } from "typebox";
import bridgePy from "../../../sandbox/egress/bridge.py?raw";
import credentialsPy from "../../../sandbox/egress/credentials.py?raw";
import egressDockerfile from "../../../sandbox/egress/Dockerfile?raw";
import sandboxDockerfile from "../../../sandbox/Dockerfile?raw";
import { log } from "../../log.ts";
import type { AccessToken } from "../oauth.ts";
import { type Daemon, daemon } from "./daemon.ts";
import { type CommandChannel, type CommandClient, lost } from "../../computer/commands.ts";
import type { OpenDaemon } from "./phone-connection.ts";
import { messageOf, orLogged, sleep, untilFailure, whilePending } from "../../promise.ts";
import { decode } from "../../parse.ts";
import { randomHex, sha256Hex } from "../../encoding.ts";
import { shellQuote } from "../shell.ts";

const CONTAINER = "pim-main";
const NETWORK = "pi-mobile";
const EGRESS = "pi-mobile-egress";
const SANDBOX_IMAGE = "pi-mobile/sandbox";
const EGRESS_IMAGE = "pi-mobile/egress";
const PROXY = `http://${EGRESS}:8080`;
const CA_PATH = "/usr/local/share/ca-certificates/pi-egress.crt";
const EGRESS_CA = "/home/mitmproxy/.mitmproxy/mitmproxy-ca-cert.pem";
const DAEMON = "/usr/local/bin/pi-env";
const CPUS = "2";
const MEMORY = "2g";
const PIDS = "512";
const BRIDGE_PING_MS = 10_000;

const SANDBOX_ENV: Record<string, string> = {
	HTTP_PROXY: PROXY,
	HTTPS_PROXY: PROXY,
	http_proxy: PROXY,
	https_proxy: PROXY,
	NO_PROXY: "localhost,127.0.0.1,::1",
	no_proxy: "localhost,127.0.0.1,::1",
	GH_TOKEN: "injected-by-pi-egress",
	GIT_TERMINAL_PROMPT: "0",
	CLOUDSDK_AUTH_ACCESS_TOKEN_FILE: "/etc/pi-egress/gcloud-token",
	CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE: "/etc/ssl/certs/ca-certificates.crt",
	CLOUDSDK_CORE_DISABLE_PROMPTS: "1",
	CLOUDSDK_CORE_DISABLE_USAGE_REPORTING: "true",
	CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: "true",
	CLOUDFLARE_API_TOKEN: "injected-by-pi-egress",
	WRANGLER_SEND_METRICS: "false",
	IDENTITY_ENDPOINT: `http://${EGRESS}:9002/azure/identity`,
	IDENTITY_HEADER: "pi-mobile",
	AZURE_CORE_COLLECT_TELEMETRY: "no",
	AZURE_CORE_ONLY_SHOW_ERRORS: "true",
	NODE_EXTRA_CA_CERTS: "/etc/ssl/certs/ca-certificates.crt",
	NODE_USE_ENV_PROXY: "1",
	REQUESTS_CA_BUNDLE: "/etc/ssl/certs/ca-certificates.crt",
	SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
};

export interface MintedService {
	get(scope?: string): Promise<AccessToken>;
	env: Record<string, string>;
}

export interface Credentials {
	githubToken?: string;
	minted: Record<string, MintedService>;
}

const MINTED_LABELS: Record<string, string> = { gcloud: "Google Cloud", cloudflare: "Cloudflare", azure: "Azure" };

const AuthorizeRequest = Type.Object({
	type: Type.Literal("authorize"),
	id: Type.Number(),
	body: Type.Object({ service: Type.Optional(Type.String()), scope: Type.Optional(Type.String()) }),
});

const EGRESS_FILES = { Dockerfile: egressDockerfile, "credentials.py": credentialsPy, "bridge.py": bridgePy };

function arch(value: string): "x64" | "arm64" | undefined {
	const name = value.trim();
	if (name === "x86_64" || name === "amd64") return "x64";
	if (name === "aarch64" || name === "arm64") return "arm64";
	return undefined;
}

function lineReader(onLine: (line: string) => void): (data: Uint8Array) => void {
	const decoder = new TextDecoder();
	let buffer = "";
	return (data) => {
		const from = buffer.length;
		buffer += decoder.decode(data, { stream: true });
		let newline = buffer.indexOf("\n", from);
		while (newline >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			onLine(line);
			newline = buffer.indexOf("\n");
		}
	};
}

type BridgeLink = { kind: "starting" } | { kind: "open"; channel: CommandChannel } | { kind: "stopped" };

export class ContainerHost {
	readonly #engine: string;
	readonly #client: CommandClient;
	readonly #home: string;
	#prepared: string | undefined;
	#arch: "x64" | "arm64" | undefined;

	constructor(engine: string, client: CommandClient, home: string) {
		this.#engine = engine;
		this.#client = client;
		this.#home = home;
	}

	async #engineOutput(args: string, input?: Uint8Array): Promise<string> {
		const result = await this.#client.run(`${this.#engine} ${args}`, input);
		if (result.code !== 0) throw new Error(`${this.#engine} ${args.split(" ")[0]}: ${result.stderr.trim() || `exit ${result.code}`}`);
		return result.stdout.trim();
	}

	async #outputIfSucceeds(args: string): Promise<string | undefined> {
		const result = await this.#client.run(`${this.#engine} ${args}`);
		return result.code === 0 ? result.stdout.trim() : undefined;
	}

	async #stage(command: string, input?: Uint8Array): Promise<void> {
		const result = await this.#client.run(command, input);
		if (result.code !== 0) throw new Error(`準備建置檔案失敗（${command.split(" ")[0]}）：${result.stderr.trim() || `exit ${result.code}`}`);
	}

	async ensureImages(onProgress: (detail: string) => void): Promise<void> {
		const engineArch = arch((await this.#outputIfSucceeds("info --format '{{.Architecture}}'")) ?? "") ?? arch((await this.#outputIfSucceeds("info --format '{{.Host.Arch}}'")) ?? "");
		if (!engineArch) throw new Error(`讀不到 ${this.#engine} 的架構`);
		await this.#buildUnlessCurrent(SANDBOX_IMAGE, { Dockerfile: sandboxDockerfile }, onProgress, daemon("linux", engineArch));
		await this.#buildUnlessCurrent(EGRESS_IMAGE, EGRESS_FILES, onProgress);
	}

	async #buildUnlessCurrent(
		name: string,
		files: Record<string, string>,
		onProgress: (detail: string) => void,
		piEnv?: Daemon,
	): Promise<void> {
		const hash = await sha256Hex(new TextEncoder().encode(JSON.stringify(files) + (piEnv?.sha ?? "")));
		const current = await this.#outputIfSucceeds(`image inspect -f '{{index .Config.Labels "dev.pi-mobile.hash"}}' ${name}`);
		if (current === hash) return;
		const dir = `${this.#home}/.pi/mobile/build/${name.split("/")[1]}`;
		await this.#stage(`rm -rf ${shellQuote(dir)} && mkdir -p ${shellQuote(dir)}`);
		for (const [file, text] of Object.entries(files)) {
			await this.#stage(`cat > ${shellQuote(`${dir}/${file}`)}`, new TextEncoder().encode(text));
		}
		if (piEnv) await this.#stage(`cat > ${shellQuote(`${dir}/pi-env`)} && chmod 755 ${shellQuote(`${dir}/pi-env`)}`, await piEnv.bytes());
		onProgress(`建置 ${name}`);
		const built = await new Promise<{ code: number | undefined; tail: string }>((resolve, reject) => {
			let tail = "";
			const take = (data: Uint8Array) => {
				tail = (tail + new TextDecoder().decode(data)).slice(-4000);
				const line = tail.trimEnd().split("\n").at(-1)?.trim();
				if (line) onProgress(`${name}：${line.slice(0, 80)}`);
			};
			this.#client
				.exec(`${this.#engine} build -t ${name} --label dev.pi-mobile.hash=${hash} ${shellQuote(dir)} 2>&1`, {
					onStdout: take,
					onExit: (code) => resolve({ code, tail }),
				})
				.then((channel) => channel.end(), reject);
		});
		if (built.code !== 0) throw new Error(`建置 ${name} 失敗：${built.tail.trim().split("\n").slice(-3).join(" / ")}`);
	}

	readonly #ensureEgress = untilFailure(async () => {
		if (!(await this.#outputIfSucceeds(`image inspect -f '{{.Id}}' ${SANDBOX_IMAGE}`))) {
			throw lost("容器還沒準備好：打開設定 › 電腦，等它準備完成");
		}
		await this.#buildUnlessCurrent(EGRESS_IMAGE, EGRESS_FILES, (detail) => log.info("egress.build", { detail }));
		const image = await this.#engineOutput(`image inspect -f '{{.Id}}' ${EGRESS_IMAGE}`);
		if (!(await this.#outputIfSucceeds(`network inspect ${NETWORK} --format '{{.Name}}'`))) await this.#engineOutput(`network create ${NETWORK}`);
		const current = (await this.#outputIfSucceeds(`inspect -f '{{.Image}} {{.State.Running}}' ${EGRESS}`)) ?? "";
		const [imageId, running] = current.split(" ");
		if (imageId !== image || running !== "true") {
			if (current) await this.#engineOutput(`rm -f ${EGRESS}`);
			const secret = randomHex(24);
			await this.#engineOutput(
				[
					"run -d",
					`--name ${EGRESS}`,
					`--network ${NETWORK}`,
					"--restart unless-stopped",
					`-v ${EGRESS}-ca:/home/mitmproxy/.mitmproxy`,
					"-e BRIDGE_URL=http://127.0.0.1:9001",
					`-e EGRESS_SECRET=${secret}`,
					EGRESS_IMAGE,
				].join(" "),
			);
		}
		const cert = await this.#outputIfSucceeds(
			`exec ${EGRESS} sh -c ${shellQuote(`for i in $(seq 40); do grep -q 'BEGIN CERTIFICATE' ${EGRESS_CA} 2>/dev/null && exec cat ${EGRESS_CA}; sleep 0.25; done; exit 1`)}`,
		);
		if (!cert?.includes("BEGIN CERTIFICATE")) throw new Error("egress proxy 沒有產生 CA 憑證");
		return `${cert}\n`;
	});

	bridge(credentials: Credentials): () => void {
		let link: BridgeLink = { kind: "starting" };
		const stopped = () => link.kind === "stopped";
		const send = (message: unknown) => {
			if (link.kind === "open") link.channel.write(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
		};
		const run = async (): Promise<void> => {
			await this.#ensureEgress();
			if (stopped()) return;
			const ping = setInterval(() => send({ type: "ping" }), BRIDGE_PING_MS);
			const ended = new Promise<void>((resolve) => {
				void this.#client
					.exec(`${this.#engine} exec -i ${EGRESS} python3 /egress/bridge.py`, {
						onStdout: lineReader((line) => void this.#onBridge(line, credentials, send)),
						onExit: (code) => {
							if (code === 3) log.warn("sandbox.bridge_busy", { engine: this.#engine });
							if (link.kind === "open") link = { kind: "starting" };
							resolve();
						},
					})
					.then((channel) => {
						if (link.kind === "stopped") return channel.close();
						link = { kind: "open", channel };
						const tenant = credentials.minted.azure?.env.AZURE_TENANT_ID;
						if (tenant) send({ type: "config", azureTenant: tenant });
					});
			});
			await ended.finally(() => clearInterval(ping));
		};
		const loop = async () => {
			let delay = 1000;
			while (!stopped()) {
				const started = Date.now();
				await orLogged(run(), "egress.bridge_ended", undefined, { engine: this.#engine });
				if (stopped()) return;
				delay = Date.now() - started > 30_000 ? 1000 : Math.min(delay * 2, 30_000);
				await sleep(delay);
			}
		};
		void loop();
		return () => {
			const was = link;
			link = { kind: "stopped" };
			if (was.kind === "open") was.channel.close();
		};
	}

	async #onBridge(line: string, credentials: Credentials, send: (message: unknown) => void): Promise<void> {
		const message = decode(AuthorizeRequest, line);
		if (!message) return;
		const result = await this.#authorize(message.body, credentials);
		send({ type: "result", id: message.id, result });
	}

	async #authorize({ service = "github", scope }: Static<typeof AuthorizeRequest>["body"], credentials: Credentials): Promise<{ token?: string; reason?: string }> {
		if (service === "github") return credentials.githubToken ? { token: credentials.githubToken } : { reason: "手機沒有設定 GitHub token" };
		const label = MINTED_LABELS[service] ?? service;
		const source = credentials.minted[service];
		if (!source) return { reason: `手機沒有設定 ${label} 憑證` };
		try {
			return { token: (await source.get(scope || undefined)).token };
		} catch (error) {
			return { reason: `取得 ${label} token 失敗：${messageOf(error)}` };
		}
	}

	readonly #ensure = whilePending(() => this.#ensureNow());

	async #ensureNow(): Promise<string> {
		const [state, id = ""] = (await this.#outputIfSucceeds(`inspect -f '{{.State.Running}} {{.Id}}' ${CONTAINER}`))?.split(" ") ?? [];
		if (state === "true") return id;
		if (state === "false") {
			await this.#engineOutput(`start ${CONTAINER}`);
			return id;
		}
		return this.#engineOutput(
			[
				"run -d",
				`--name ${CONTAINER}`,
				`--hostname ${CONTAINER}`,
				`--cpus ${CPUS}`,
				`--memory ${MEMORY}`,
				`--pids-limit ${PIDS}`,
				"--restart no",
				`--network ${NETWORK}`,
				`-v ${CONTAINER}:/workspace`,
				SANDBOX_IMAGE,
			].join(" "),
		);
	}

	async #prepare(id: string, ca: string, piEnv: Daemon): Promise<void> {
		if (this.#prepared === id) return;
		await this.#engineOutput(
			`exec -i ${CONTAINER} sh -c ${shellQuote(
				`cat > /tmp/pi-egress.crt && if ! cmp -s /tmp/pi-egress.crt ${CA_PATH}; then mv /tmp/pi-egress.crt ${CA_PATH} && update-ca-certificates >/dev/null 2>&1; else rm /tmp/pi-egress.crt; fi`,
			)}`,
			new TextEncoder().encode(ca),
		);
		const present = await this.#outputIfSucceeds(`exec ${CONTAINER} sha256sum ${DAEMON}`);
		if (present?.split(" ")[0] !== piEnv.sha) {
			await this.#engineOutput(
				`exec -i ${CONTAINER} sh -c ${shellQuote(`cat > ${DAEMON}.new && chmod 755 ${DAEMON}.new && mv ${DAEMON}.new ${DAEMON}`)}`,
				await piEnv.bytes(),
			);
		}
		this.#prepared = id;
	}

	opener(serviceEnv: () => Record<string, string>): OpenDaemon {
		return async (token, handlers) => {
			const ca = await this.#ensureEgress();
			const id = await this.#ensure();
			this.#arch ??= arch(await this.#engineOutput(`exec ${CONTAINER} uname -m`));
			if (!this.#arch) throw lost("讀不到 sandbox 的架構");
			await this.#prepare(id, ca, daemon("linux", this.#arch));
			const env = Object.entries({ ...SANDBOX_ENV, ...serviceEnv() })
				.map(([key, value]) => `-e ${shellQuote(`${key}=${value}`)}`)
				.join(" ");
			let stderr = "";
			const channel = await this.#client.exec(
				`exec ${this.#engine} exec -i -w /workspace ${env} ${CONTAINER} ${DAEMON} serve --token ${token}`,
				{
					onStdout: handlers.onData,
					onStderr: (data) => {
						stderr = (stderr + new TextDecoder().decode(data)).slice(-2000);
					},
					onExit: (code) => {
						handlers.onClose(stderr.trim() || `daemon exited ${code ?? "?"}`);
					},
					onLink: handlers.onLink,
				},
				token,
			);
			return { send: (data) => channel.write(data), close: () => channel.close() };
		};
	}
}
