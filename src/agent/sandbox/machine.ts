// The owner's machines over SSH (docs/design/sandbox-ssh.md): probe the system, deploy pi-env's daemon, and run it as
// the SSH user ("trusted" mode). Deployment follows pi-env's connectSsh: the daemon for the remote system, named by its
// SHA-256 under ~/.pi/env and verified before every start. Only the owner's tap deploys; a session on a machine that
// was never connected is refused.
import { type Static, Type } from "typebox";
import { parse } from "../parse.ts";
import { ContainerHost } from "./container.ts";
import { type HostKey, SshClient } from "./ssh.ts";
import { lost, StreamConnection } from "./stream-connection.ts";

export const MachineSchema = Type.Object({
	id: Type.String(),
	name: Type.String(),
	host: Type.String(),
	port: Type.Number(),
	user: Type.String(),
	/** The host key the owner accepted (base64 blob) and its fingerprint. */
	hostKey: Type.String(),
	fingerprint: Type.String(),
	/** Where the daemon runs: a container per conversation behind the egress proxy, or as the SSH user. */
	mode: Type.Optional(Type.Union([Type.Literal("container"), Type.Literal("trusted")])),
	/** Set once the owner connected it: the remote system and the daemon deployed there. */
	system: Type.Optional(
		Type.Object({
			os: Type.Union([Type.Literal("linux"), Type.Literal("darwin")]),
			arch: Type.Union([Type.Literal("x64"), Type.Literal("arm64")]),
			home: Type.String(),
			daemon: Type.String(),
			/** Container engines that answer there, best first (phase 2). */
			engines: Type.Array(Type.String()),
			connectedAt: Type.Number(),
		}),
	),
});

export type Machine = Static<typeof MachineSchema>;
export type MachineSystem = NonNullable<Machine["system"]>;

const Machines = Type.Array(MachineSchema);

export function parseMachines(json: string): Machine[] {
	if (!json) return [];
	try {
		return parse(Machines, JSON.parse(json), "機器清單");
	} catch {
		return [];
	}
}

/** Single-quote for sh: works the same in bash, zsh, dash, and ash. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Non-interactive SSH sessions get a short PATH (macOS: /usr/bin:/bin:/usr/sbin:/sbin), without Homebrew's or the
 * user's own bin folders where docker, podman, or nerdctl usually are.
 */
export const ENV_PATH = 'export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/bin"';

const HASH = `h=$( (sha256sum "$f" 2>/dev/null || shasum -a 256 "$f" 2>/dev/null) | cut -d' ' -f1)`;

function daemonPath(sha: string): string {
	return `"$HOME/.pi/env/${sha}/pi-env"`;
}

/** The daemons the app carries (vite.config.ts copies them from @earendil-works/pi-env), loaded and checked once. */
const daemons = new Map<string, Promise<{ bytes: Uint8Array; sha: string }>>();
export function daemon(os: MachineSystem["os"], arch: MachineSystem["arch"]): Promise<{ bytes: Uint8Array; sha: string }> {
	const name = `${os}-${arch}`;
	let pending = daemons.get(name);
	if (!pending) {
		pending = (async () => {
			const expected = __PI_ENV_DAEMONS__[name];
			if (!expected) throw new Error(`app 沒有附 ${name} 的 pi-env`);
			const response = await fetch(`/pi-env/${name}.bin`);
			if (!response.ok) throw new Error(`讀不到 app 裡 ${name} 的 pi-env（HTTP ${response.status}）`);
			const bytes = new Uint8Array(await response.arrayBuffer());
			const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
			const sha = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
			if (sha !== expected) throw new Error(`app 裡 ${name} 的 pi-env 跟建置時不一樣，不會上傳`);
			return { bytes, sha };
		})();
		pending.catch(() => daemons.delete(name));
		daemons.set(name, pending);
	}
	return pending;
}

function platform(uname: string, machine: string): Pick<MachineSystem, "os" | "arch"> {
	const os = uname === "Linux" ? "linux" : uname === "Darwin" ? "darwin" : undefined;
	const arch = machine === "x86_64" || machine === "amd64" ? "x64" : machine === "aarch64" || machine === "arm64" ? "arm64" : undefined;
	if (!os || !arch) throw new Error(`還不支援 ${uname} ${machine}`);
	return { os, arch };
}

const PROBE = [
	ENV_PATH,
	`printf 'os=%s\\narch=%s\\nhome=%s\\n' "$(uname -s)" "$(uname -m)" "$HOME"`,
	"for e in nerdctl podman docker; do command -v $e >/dev/null 2>&1 && $e info >/dev/null 2>&1 && printf 'engine=%s\\n' $e; done",
	"true",
].join("; ");

export type ConnectStep = "connect" | "probe" | "upload" | "verify" | "images";

/**
 * The owner's "安裝並連線": probe the machine, upload the daemon unless that exact build is there, and start it once.
 * Resolves the system to record on the machine.
 */
export async function installOn(
	machine: Machine,
	onStep: (step: ConnectStep, detail?: string) => void = () => {},
): Promise<MachineSystem> {
	onStep("connect");
	const client = await SshClient.connect(machine);
	try {
		onStep("probe");
		const probe = await client.run(PROBE);
		const facts = new Map<string, string[]>();
		for (const line of probe.stdout.split("\n")) {
			const at = line.indexOf("=");
			if (at > 0) facts.set(line.slice(0, at), [...(facts.get(line.slice(0, at)) ?? []), line.slice(at + 1)]);
		}
		const { os, arch } = platform(facts.get("os")?.[0] ?? "?", facts.get("arch")?.[0] ?? "?");
		const home = facts.get("home")?.[0];
		if (!home?.startsWith("/")) throw new Error("讀不到這台機器的家目錄");
		const { bytes, sha } = await daemon(os, arch);

		const present = await client.run(`f=${daemonPath(sha)}; ${HASH}; [ "$h" = ${sha} ]`);
		if (present.code !== 0) {
			onStep("upload");
			const upload = await client.run(
				[
					"set -e",
					`d="$HOME/.pi/env/${sha}"`,
					'mkdir -p "$d"',
					'f="$d/pi-env.$$"',
					'cat > "$f"',
					HASH,
					`[ "$h" = ${sha} ] || { rm -f "$f"; echo "pi-env checksum mismatch" >&2; exit 3; }`,
					'chmod 755 "$f"',
					'mv "$f" "$d/pi-env"',
				].join("; "),
				bytes,
			);
			if (upload.code !== 0) throw new Error(`上傳 pi-env 失敗：${upload.stderr.trim() || `exit ${upload.code}`}`);
		}
		onStep("verify");
		const version = await client.run(`${daemonPath(sha)} --version`);
		if (version.code !== 0) throw new Error(`pi-env 啟動失敗：${version.stderr.trim() || `exit ${version.code}`}`);
		const system: MachineSystem = { os, arch, home, daemon: sha, engines: facts.get("engine") ?? [], connectedAt: Date.now() };
		const engine = system.engines[0];
		if (engine && machine.mode !== "trusted") {
			onStep("images");
			await new ContainerHost(engine, async () => client).ensureImages(system, (detail) => onStep("images", detail));
		}
		return system;
	} finally {
		client.close();
	}
}

/** One SSH connection per machine, opened on first use and again after it drops. */
export class MachineLink {
	readonly machine: Machine;
	#client: Promise<SshClient> | undefined;

	constructor(machine: Machine) {
		this.machine = machine;
	}

	client(): Promise<SshClient> {
		const current = this.#client;
		if (current) {
			return current.then((client) => {
				if (!client.closed) return client;
				if (this.#client === current) this.#client = undefined;
				return this.client();
			});
		}
		const next = SshClient.connect(this.machine);
		next.catch(() => {
			if (this.#client === next) this.#client = undefined;
		});
		this.#client = next;
		return next;
	}

	/** A pi-env connection whose daemon runs as the SSH user in `cwd`, created if missing. */
	connection(cwd: string, onLog?: (text: string) => void): StreamConnection {
		const system = this.machine.system;
		return new StreamConnection({
			...(onLog ? { onLog } : {}),
			open: async (token, handlers) => {
				if (!system) throw lost(`${this.machine.name} 還沒連線：到設定裡按「安裝並連線」`);
				const client = await this.client();
				// Verified before every start, as pi-env's own deployment does: a changed file is never run.
				const command = [
					`f=${daemonPath(system.daemon)}`,
					HASH,
					`[ "$h" = ${system.daemon} ] || { echo "pi-env daemon missing or changed; connect the machine again" >&2; exit 97; }`,
					`mkdir -p ${shellQuote(cwd)}`,
					`cd ${shellQuote(cwd)}`,
					`exec "$f" serve --token ${token}`,
				].join("; ");
				let stderr = "";
				const stop = client.onClose((reason) => handlers.onClose(`SSH ${reason}`));
				const channel = await client.exec(command, {
					onStdout: handlers.onData,
					onStderr: (data) => {
						stderr = (stderr + new TextDecoder().decode(data)).slice(-2000);
					},
					onExit: (code) => {
						stop();
						handlers.onClose(stderr.trim() || `daemon exited ${code ?? "?"}`);
					},
				});
				return { send: (data) => channel.write(data), close: () => channel.close() };
			},
		});
	}

	close(): void {
		void this.#client?.then((client) => client.close(), () => undefined);
		this.#client = undefined;
	}
}

export type { HostKey };
