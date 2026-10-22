// Containers on one of the user's computers (docs/design/computer-host.md): one shared by all bots, behind the egress
// proxy, driven by the phone with the engine's CLI (docker, podman, or nerdctl; only the subset they share) through
// pi-host's command channel. The proxy reaches the phone through bridge.py on such a channel, so no credential is
// stored on the computer: it asks the phone for a token, and the phone asks the user before a write.
import bridgePy from "../../../sandbox/egress/bridge.py?raw";
import credentialsPy from "../../../sandbox/egress/credentials.py?raw";
import egressDockerfile from "../../../sandbox/egress/Dockerfile?raw";
import sandboxDockerfile from "../../../sandbox/Dockerfile?raw";
import { log } from "../../log.ts";
import { requestConfirmation } from "../confirm.ts";
import type { AccessToken } from "../oauth.ts";
import { daemon, ENV_PATH, shellQuote } from "./daemon.ts";
import type { OpenDaemon } from "./stream-connection.ts";
import { lost } from "./stream-connection.ts";

const PREFIX = "pim-";
const LABEL = "pi-mobile=1";
const NETWORK = "pi-mobile";
const EGRESS = "pi-mobile-egress";
const SANDBOX_IMAGE = "pi-mobile/sandbox";
const EGRESS_IMAGE = "pi-mobile/egress";
const PROXY = `http://${EGRESS}:8080`;
const CA_PATH = "/usr/local/share/ca-certificates/pi-egress.crt";
const DAEMON = "/usr/local/bin/pi-env";
const MAX_RUNNING = 6;
const CPUS = "2";
const MEMORY = "2g";
const PIDS = "512";
const APPROVAL_TIMEOUT_MS = 5 * 60_000;
/** bridge.py exits after 35 seconds without hearing from the phone, so another phone can take over. */
const BRIDGE_PING_MS = 10_000;
const BRIDGE_PATH = "/tmp/pi-mobile-bridge.py";

/** Environment for the daemon and everything it runs: proxy, CA bundle for runtimes with their own, placeholders. */
const SANDBOX_ENV: Record<string, string> = {
	HTTP_PROXY: PROXY,
	HTTPS_PROXY: PROXY,
	http_proxy: PROXY,
	https_proxy: PROXY,
	NO_PROXY: "localhost,127.0.0.1,::1",
	no_proxy: "localhost,127.0.0.1,::1",
	// gh refuses to run without a token; the proxy replaces this placeholder with the real one.
	GH_TOKEN: "injected-by-pi-egress",
	GIT_TERMINAL_PROMPT: "0",
	CLOUDSDK_AUTH_ACCESS_TOKEN_FILE: "/etc/pi-egress/gcloud-token",
	CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE: "/etc/ssl/certs/ca-certificates.crt",
	CLOUDSDK_CORE_DISABLE_PROMPTS: "1",
	CLOUDSDK_CORE_DISABLE_USAGE_REPORTING: "true",
	CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: "true",
	CLOUDFLARE_API_TOKEN: "injected-by-pi-egress",
	WRANGLER_SEND_METRICS: "false",
	// az signs in as a managed identity that bridge.py serves with placeholders; the proxy swaps in real tokens.
	IDENTITY_ENDPOINT: `http://${EGRESS}:9002/azure/identity`,
	IDENTITY_HEADER: "pi-mobile",
	AZURE_CORE_COLLECT_TELEMETRY: "no",
	AZURE_CORE_ONLY_SHOW_ERRORS: "true",
	NODE_EXTRA_CA_CERTS: "/etc/ssl/certs/ca-certificates.crt",
	NODE_USE_ENV_PROXY: "1",
	REQUESTS_CA_BUNDLE: "/etc/ssl/certs/ca-certificates.crt",
	SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
};

/** A service whose access tokens the phone mints on request. */
export interface MintedService {
	/** `scope` names the resource for services with one token per resource (Azure); others ignore it. */
	get(scope?: string): Promise<AccessToken>;
	/** Sandbox environment for this service, such as the default project or account. */
	env: Record<string, string>;
}

export interface CommandHandlers {
	onStdout(data: Uint8Array): void;
	onStderr?(data: Uint8Array): void;
	onExit(code: number | undefined): void;
}

export interface CommandChannel {
	write(data: Uint8Array): void;
	/** End stdin: the command sees end of input. */
	end(): void;
	close(): void;
}

/** Runs shell commands on the computer, as its user, from home (pi-host's /exec). */
export interface CommandClient {
	exec(command: string, handlers: CommandHandlers): Promise<CommandChannel>;
	/** Run a command to the end: its stdout as text, stderr, and exit code. `input` is sent as stdin. */
	run(command: string, input?: Uint8Array): Promise<{ stdout: string; stderr: string; code: number | undefined }>;
}

export interface Credentials {
	githubToken: string | undefined;
	/** By proxy service name: "gcloud", "cloudflare", "azure". */
	minted: Record<string, MintedService>;
}

const MINTED_LABELS: Record<string, string> = { gcloud: "Google Cloud", cloudflare: "Cloudflare", azure: "Azure" };

const EGRESS_FILES = { Dockerfile: egressDockerfile, "credentials.py": credentialsPy, "bridge.py": bridgePy };

async function sha256(text: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
	return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Linux architecture of the engine's VM or host, in Node's names. */
function arch(value: string): "x64" | "arm64" | undefined {
	const name = value.trim();
	if (name === "x86_64" || name === "amd64") return "x64";
	if (name === "aarch64" || name === "arm64") return "arm64";
	return undefined;
}

export class ContainerHost {
	readonly #engine: string;
	readonly #client: () => Promise<CommandClient>;
	#egress: Promise<string> | undefined;
	/** Container ids that trust the egress CA and run the expected daemon, since the app started. */
	readonly #prepared = new Set<string>();
	/** Sandboxes with an open daemon session from this app. */
	readonly #active = new Map<string, number>();
	readonly #ensuring = new Map<string, Promise<void>>();

	constructor(engine: string, client: () => Promise<CommandClient>) {
		this.#engine = engine;
		this.#client = client;
	}

	/** Run an engine command; its stdout trimmed, or a thrown error with stderr. */
	async #e(args: string, input?: Uint8Array): Promise<string> {
		const client = await this.#client();
		const result = await client.run(`${ENV_PATH}; ${this.#engine} ${args}`, input);
		if (result.code !== 0) throw new Error(`${this.#engine} ${args.split(" ")[0]}: ${result.stderr.trim() || `exit ${result.code}`}`);
		return result.stdout.trim();
	}

	async #tryE(args: string): Promise<string | undefined> {
		return this.#e(args).catch(() => undefined);
	}

	// ---------- Images ----------

	/**
	 * Build the sandbox and egress images on the host unless images from the same files are there (labeled with their
	 * hash). The first build takes minutes; `onProgress` gets the build's last output line.
	 */
	async ensureImages(home: string, onProgress: (detail: string) => void): Promise<void> {
		const engineArch = arch((await this.#tryE("info --format '{{.Architecture}}'")) ?? "") ?? arch((await this.#tryE("info --format '{{.Host.Arch}}'")) ?? "");
		if (!engineArch) throw new Error(`讀不到 ${this.#engine} 的架構`);
		const piEnv = await daemon("linux", engineArch);
		await this.#buildUnlessCurrent(SANDBOX_IMAGE, { Dockerfile: sandboxDockerfile }, home, onProgress, piEnv);
		await this.#buildUnlessCurrent(EGRESS_IMAGE, EGRESS_FILES, home, onProgress);
	}

	async #buildUnlessCurrent(
		name: string,
		files: Record<string, string>,
		home: string,
		onProgress: (detail: string) => void,
		piEnv?: { sha: string; bytes: Uint8Array },
	): Promise<void> {
		const hash = await sha256(JSON.stringify(files) + (piEnv?.sha ?? ""));
		const current = await this.#tryE(`image inspect -f '{{index .Config.Labels "dev.pi-mobile.hash"}}' ${name}`);
		if (current === hash) return;
		const client = await this.#client();
		const dir = `${home}/.pi/mobile/build/${name.split("/")[1]}`;
		await client.run(`rm -rf ${shellQuote(dir)} && mkdir -p ${shellQuote(dir)}`);
		for (const [file, text] of Object.entries(files)) {
			await client.run(`cat > ${shellQuote(`${dir}/${file}`)}`, new TextEncoder().encode(text));
		}
		if (piEnv) await client.run(`cat > ${shellQuote(`${dir}/pi-env`)} && chmod 755 ${shellQuote(`${dir}/pi-env`)}`, piEnv.bytes);
		onProgress(`建置 ${name}`);
		const built = await new Promise<{ code: number | undefined; tail: string }>((resolve, reject) => {
			let tail = "";
			const take = (data: Uint8Array) => {
				tail = (tail + new TextDecoder().decode(data)).slice(-4000);
				const line = tail.trimEnd().split("\n").at(-1)?.trim();
				if (line) onProgress(`${name}：${line.slice(0, 80)}`);
			};
			client
				.exec(`${ENV_PATH}; ${this.#engine} build -t ${name} --label dev.pi-mobile.hash=${hash} ${shellQuote(dir)} 2>&1`, {
					onStdout: take,
					onExit: (code) => resolve({ code, tail }),
				})
				.then((channel) => channel.end(), reject);
		});
		if (built.code !== 0) throw new Error(`建置 ${name} 失敗：${built.tail.trim().split("\n").slice(-3).join(" / ")}`);
	}

	async #home(): Promise<string> {
		const result = await (await this.#client()).run("printf %s \"$HOME\"");
		if (result.code !== 0 || !result.stdout) throw new Error("讀不到主機的家目錄");
		return result.stdout;
	}

	// ---------- Egress ----------

	/** Network and proxy container, recreated when its image changed; resolves the proxy's CA certificate. */
	#ensureEgress(): Promise<string> {
		this.#egress ??= (async () => {
			if (!(await this.#tryE(`image inspect -f '{{.Id}}' ${SANDBOX_IMAGE}`))) {
				throw lost("容器還沒準備好：打開設定 › 電腦，等它準備完成");
			}
			await this.#buildUnlessCurrent(EGRESS_IMAGE, EGRESS_FILES, await this.#home(), (detail) => log.info("egress.build", { detail }));
			const image = await this.#e(`image inspect -f '{{.Id}}' ${EGRESS_IMAGE}`);
			if (!(await this.#tryE(`network inspect ${NETWORK} --format '{{.Name}}'`))) await this.#e(`network create ${NETWORK}`);
			const current = (await this.#tryE(`inspect -f '{{.Image}} {{.State.Running}}' ${EGRESS}`)) ?? "";
			const [imageId, running] = current.split(" ");
			if (imageId !== image || running !== "true") {
				if (current) await this.#e(`rm -f ${EGRESS}`);
				const secret = [...crypto.getRandomValues(new Uint8Array(24))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
				await this.#e(
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
			// mitmproxy writes its CA on first start.
			for (let attempt = 0; attempt < 40; attempt++) {
				const cert = await this.#tryE(`exec ${EGRESS} cat /home/mitmproxy/.mitmproxy/mitmproxy-ca-cert.pem`);
				if (cert?.includes("BEGIN CERTIFICATE")) return `${cert}\n`;
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
			throw new Error("egress proxy 沒有產生 CA 憑證");
		})();
		this.#egress.catch(() => {
			this.#egress = undefined;
		});
		return this.#egress;
	}

	/**
	 * Keep bridge.py running in the proxy while the phone is connected, answering its questions with `credentials`.
	 * Returns a stop function; the bridge restarts when its channel ends while the link is still wanted.
	 */
	bridge(credentials: Credentials): () => void {
		let stopped = false;
		let close: (() => void) | undefined;
		const run = async (): Promise<void> => {
			await this.#ensureEgress();
			// The phone's side of the protocol is this app's version, so the bridge is too, not the one in the image.
			await this.#e(`exec -i ${EGRESS} sh -c 'cat > ${BRIDGE_PATH}'`, new TextEncoder().encode(bridgePy));
			const client = await this.#client();
			let buffer = "";
			let send: (message: unknown) => void = () => {};
			const ping = setInterval(() => send({ type: "ping" }), BRIDGE_PING_MS);
			const ended = new Promise<void>((resolve) => {
				void client
					.exec(`${ENV_PATH}; ${this.#engine} exec -i ${EGRESS} python3 ${BRIDGE_PATH}`, {
						onStdout: (data) => {
							buffer += new TextDecoder().decode(data);
							let newline = buffer.indexOf("\n");
							while (newline >= 0) {
								const line = buffer.slice(0, newline);
								buffer = buffer.slice(newline + 1);
								void this.#onBridge(line, credentials, send);
								newline = buffer.indexOf("\n");
							}
						},
						onExit: (code) => {
							// 3: another phone's bridge is live; retried with backoff below.
							if (code === 3) log.warn("sandbox.bridge_busy", { engine: this.#engine });
							resolve();
						},
					})
					.then((channel) => {
						close = () => channel.close();
						send = (message) => channel.write(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
						const tenant = credentials.minted.azure?.env.AZURE_TENANT_ID;
						if (tenant) send({ type: "config", azureTenant: tenant });
					});
			});
			await ended.finally(() => clearInterval(ping));
		};
		const loop = async () => {
			let delay = 1000;
			while (!stopped) {
				const started = Date.now();
				await run().catch(() => undefined);
				if (stopped) return;
				delay = Date.now() - started > 30_000 ? 1000 : Math.min(delay * 2, 30_000);
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		};
		void loop();
		return () => {
			stopped = true;
			close?.();
		};
	}

	async #onBridge(line: string, credentials: Credentials, send: (message: unknown) => void): Promise<void> {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		if (typeof message !== "object" || message === null || !("type" in message) || message.type !== "authorize") return;
		if (!("id" in message) || typeof message.id !== "number" || !("body" in message)) return;
		const result = await this.#authorize(message.body, credentials).catch((error: unknown) => ({
			reason: error instanceof Error ? error.message : String(error),
		}));
		send({ type: "result", id: message.id, result });
	}

	/** The answer to the proxy: a token for reads, and for writes the user approved on the phone. */
	async #authorize(body: unknown, credentials: Credentials): Promise<{ token?: string; reason?: string }> {
		const field = (key: string): unknown => (typeof body === "object" && body !== null && key in body ? Reflect.get(body, key) : undefined);
		const service = String(field("service") ?? "github");
		const write = field("write") === true;
		const title = String(field("title") ?? "");
		const detail = String(field("detail") ?? "");
		const scope = String(field("scope") ?? "");
		const token = async (): Promise<{ token?: string; reason?: string }> => {
			if (service === "github") return credentials.githubToken ? { token: credentials.githubToken } : { reason: "手機沒有設定 GitHub token" };
			const label = MINTED_LABELS[service] ?? service;
			const source = credentials.minted[service];
			if (!source) return { reason: `手機沒有設定 ${label} 憑證` };
			try {
				return { token: (await source.get(scope || undefined)).token };
			} catch (error) {
				return { reason: `取得 ${label} token 失敗：${error instanceof Error ? error.message : String(error)}` };
			}
		};
		const read = await token();
		if (!read.token || !write) return read;
		// One sandbox serves every bot, so the request is not attributed to one.
		const approved = await Promise.race([
			requestConfirmation({ title, detail: ["來自 sandbox", detail].filter(Boolean).join("\n\n") }),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), APPROVAL_TIMEOUT_MS)),
		]);
		return approved ? read : { reason: "使用者拒絕了這個寫入" };
	}

	// ---------- Sandboxes ----------

	/** Create or start the sandbox's container; serialized per sandbox so two connections do not race. */
	#ensure(name: string): Promise<void> {
		const pending = this.#ensuring.get(name) ?? this.#ensureNow(name).finally(() => this.#ensuring.delete(name));
		this.#ensuring.set(name, pending);
		return pending;
	}

	async #ensureNow(name: string): Promise<void> {
		const container = PREFIX + name;
		const state = await this.#tryE(`inspect -f '{{.State.Running}}' ${container}`);
		if (state === "true") return;
		await this.#makeRoom();
		if (state === "false") {
			await this.#e(`start ${container}`);
			return;
		}
		await this.#e(
			[
				"run -d",
				`--name ${container}`,
				`--label ${LABEL}`,
				`--hostname ${container}`,
				`--cpus ${CPUS}`,
				`--memory ${MEMORY}`,
				`--pids-limit ${PIDS}`,
				"--restart no",
				`--network ${NETWORK}`,
				`-v ${container}:/workspace`,
				SANDBOX_IMAGE,
			].join(" "),
		);
	}

	/** At the running limit, stop the longest-running sandbox this app has no session with. */
	async #makeRoom(): Promise<void> {
		const ids = await this.#tryE(`ps -q --filter label=${LABEL}`);
		const running = ids ? ids.split(/\s+/) : [];
		if (running.length < MAX_RUNNING) return;
		const out = await this.#e(`inspect -f '{{.Name}} {{.State.StartedAt}}' ${running.join(" ")}`);
		const idle = out
			.split("\n")
			.map((line) => line.trim().split(" "))
			.map(([name = "", started = ""]) => ({ name: name.replace(/^\//, ""), started }))
			.filter((candidate) => !this.#active.has(candidate.name.replace(PREFIX, "")))
			.sort((a, b) => a.started.localeCompare(b.started))[0];
		if (!idle) throw new Error(`${MAX_RUNNING} 個 sandbox 都在使用中`);
		await this.#e(`stop -t 2 ${idle.name}`);
	}

	/** Trust the proxy's CA and run this app's daemon, once per container id. */
	async #prepare(name: string, ca: string, daemonSha: string, daemonBytes: () => Promise<Uint8Array>): Promise<void> {
		const container = PREFIX + name;
		const id = await this.#e(`inspect -f '{{.Id}}' ${container}`);
		if (this.#prepared.has(id)) return;
		await this.#e(
			`exec -i ${container} sh -c ${shellQuote(
				`cat > /tmp/pi-egress.crt && if ! cmp -s /tmp/pi-egress.crt ${CA_PATH}; then mv /tmp/pi-egress.crt ${CA_PATH} && update-ca-certificates >/dev/null 2>&1; else rm /tmp/pi-egress.crt; fi`,
			)}`,
			new TextEncoder().encode(ca),
		);
		const present = await this.#tryE(`exec ${container} sha256sum ${DAEMON}`);
		if (present?.split(" ")[0] !== daemonSha) {
			await this.#e(
				`exec -i ${container} sh -c ${shellQuote(`cat > ${DAEMON}.new && chmod 755 ${DAEMON}.new && mv ${DAEMON}.new ${DAEMON}`)}`,
				await daemonBytes(),
			);
		}
		this.#prepared.add(id);
	}

	/** Opens `pi-env serve` in the sandbox's container, creating and preparing it first. */
	opener(name: string, serviceEnv: () => Record<string, string>): OpenDaemon {
		return async (token, handlers) => {
			const ca = await this.#ensureEgress();
			await this.#ensure(name);
			const machineArch = arch((await this.#e(`exec ${PREFIX + name} uname -m`)) ?? "");
			if (!machineArch) throw lost("讀不到 sandbox 的架構");
			const piEnv = await daemon("linux", machineArch);
			await this.#prepare(name, ca, piEnv.sha, async () => piEnv.bytes);
			const env = Object.entries({ ...SANDBOX_ENV, ...serviceEnv() })
				.map(([key, value]) => `-e ${shellQuote(`${key}=${value}`)}`)
				.join(" ");
			const client = await this.#client();
			this.#active.set(name, (this.#active.get(name) ?? 0) + 1);
			let released = false;
			const release = () => {
				if (released) return;
				released = true;
				const left = (this.#active.get(name) ?? 1) - 1;
				if (left > 0) this.#active.set(name, left);
				else this.#active.delete(name);
			};
			let stderr = "";
			const channel = await client.exec(
				`${ENV_PATH}; exec ${this.#engine} exec -i -w /workspace ${env} ${PREFIX + name} ${DAEMON} serve --token ${token}`,
				{
					onStdout: handlers.onData,
					onStderr: (data) => {
						stderr = (stderr + new TextDecoder().decode(data)).slice(-2000);
					},
					onExit: (code) => {
						release();
						handlers.onClose(stderr.trim() || `daemon exited ${code ?? "?"}`);
					},
				},
			);
			return { send: (data) => channel.write(data), close: () => channel.close() };
		};
	}

	async exists(name: string): Promise<boolean> {
		return (await this.#tryE(`inspect -f '{{.Id}}' ${PREFIX + name}`)) !== undefined;
	}

	async remove(name: string): Promise<void> {
		await this.#tryE(`rm -f ${PREFIX + name}`);
		await this.#tryE(`volume rm ${PREFIX + name}`);
	}
}
