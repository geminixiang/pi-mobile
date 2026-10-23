// One of the user's computers running pi-mobile serve (host/main.go), reached over the tailnet: no SSH, no key, no
// password. pi-mobile serve accepts only devices of the same Tailscale user, so the tailnet is the authentication
// (docs/design/computer-host.md). A bot works there in one of two ways:
// - directly: pi-env runs as the user from home, and the bot operates the computer itself;
// - in a container: the shared Linux sandbox behind the egress proxy (container.ts), when the computer has docker,
//   podman, or nerdctl; credentials stay on the phone.
// The phone brings pi-env: it reads /info, uploads the daemon for the computer's system when missing, and opens a
// WebSocket per connection.
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
	type JsonRpcMessage,
	type McpTransport,
	type McpTransportCloseListener,
	type McpTransportErrorListener,
	type McpTransportMessageListener,
	parseJsonRpcMessage,
} from "@earendil-works/pi-mcp";
import { log } from "../../log.ts";
import { type CommandChannel, type CommandClient, type CommandHandlers, ContainerHost, type Credentials } from "./container.ts";
import { daemon } from "./daemon.ts";
import { containerDescription, directDescription, type Sandbox, SHARED_SANDBOX, SharedEnvs } from "./sandbox.ts";
import { lost, type OpenDaemon, StreamConnection } from "./stream-connection.ts";
import { WORKSPACE } from "./workspace.ts";

export const HOST_PORT = 4790;

const System = {
	os: Type.Union([Type.Literal("darwin"), Type.Literal("linux")]),
	arch: Type.Union([Type.Literal("x64"), Type.Literal("arm64")]),
};

const HostInfo = Type.Object({
	version: Type.String(),
	...System,
	user: Type.String(),
	home: Type.String(),
	name: Type.String(),
	dnsName: Type.String(),
	daemons: Type.Array(Type.String()),
	engines: Type.Array(Type.String()),
});
export type HostInfo = Static<typeof HostInfo>;

const Host = Type.Object({
	id: Type.String(),
	/** What the user calls it: the computer's own name. */
	name: Type.String(),
	/** Its MagicDNS name (or Tailscale IP), where pi-mobile serve listens on HOST_PORT. */
	address: Type.String(),
	...System,
	user: Type.String(),
	home: Type.String(),
	/** The container engine there, first of docker, podman, nerdctl; absent without one. */
	engine: Type.Optional(Type.String()),
});
export type Host = Static<typeof Host>;

export type HostMode = "direct" | "container";

/** The settings' hosts JSON; entries that do not parse are dropped. */
export function parseHosts(json: string): Host[] {
	if (!json) return [];
	try {
		const value: unknown = JSON.parse(json);
		return Array.isArray(value) ? value.filter((item): item is Host => Value.Check(Host, item)) : [];
	} catch {
		return [];
	}
}

function base(address: string): string {
	return `http://${address.includes(":") ? `[${address}]` : address}:${HOST_PORT}`;
}

function socketUrl(address: string, path: string, params: Record<string, string>): URL {
	const url = new URL(path, base(address).replace(/^http/, "ws"));
	for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
	return url;
}

/** What pi-mobile serve on `address` says about its computer; throws in words the user can act on. */
export async function probeHost(address: string, signal?: AbortSignal): Promise<HostInfo> {
	let response: Response;
	try {
		response = await fetch(`${base(address)}/info`, { signal: signal ?? AbortSignal.timeout(15_000) });
	} catch {
		throw new Error(`連不到 ${address}：電腦要開著、連上 Tailscale，並裝好 pi-mobile`);
	}
	if (response.status === 403) throw new Error(`${address} 拒絕了這支手機：手機和電腦要登入同一個 Tailscale 帳號`);
	if (!response.ok) throw new Error(`${address} 回應 HTTP ${response.status}：${(await response.text()).trim()}`);
	const info: unknown = await response.json();
	if (!Value.Check(HostInfo, info)) throw new Error(`${address} 的回應看不懂，電腦上的 pi-mobile 可能要更新`);
	return info;
}

/** A host from what it said about itself, keeping what was known of it. */
export function hostFrom(address: string, info: HostInfo, known?: Host): Host {
	const engine = info.engines[0];
	return {
		// Its tailnet name, so that a computer removed and added again is the one bots had picked.
		id: known?.id ?? (info.dnsName || address),
		name: info.name,
		address: info.dnsName || address,
		os: info.os,
		arch: info.arch,
		user: info.user,
		home: info.home,
		...(engine ? { engine } : {}),
	};
}

const Peers = Type.Array(Type.Object({ name: Type.String(), dnsName: Type.String(), os: System.os }));
export type Peer = Static<typeof Peers>[number];

/** The user's other computers on the tailnet, as one running pi-mobile sees them; Android gives apps no peer list. */
export async function listPeers(host: Host): Promise<Peer[]> {
	const response = await fetch(`${base(host.address)}/peers`, { signal: AbortSignal.timeout(8000) });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const peers: unknown = await response.json();
	return Value.Check(Peers, peers) ? peers : [];
}

/** A WebSocket opened with its first bytes listened for before `open` resolves (they can arrive in the same task). */
function openSocket(url: URL, what: string, onMessage: (data: ArrayBuffer | string) => void, onClose: (reason: string | undefined) => void): Promise<WebSocket> {
	const socket = new WebSocket(url);
	socket.binaryType = "arraybuffer";
	socket.addEventListener("message", (event) => {
		if (event.data instanceof ArrayBuffer || typeof event.data === "string") onMessage(event.data);
	});
	return new Promise((resolve, reject) => {
		socket.addEventListener(
			"open",
			() => {
				socket.addEventListener("close", (event) => onClose(event.reason || undefined));
				resolve(socket);
			},
			{ once: true },
		);
		socket.addEventListener("error", () => reject(lost(`連不到 ${what}`)), { once: true });
	});
}

const ExitMessage = Type.Object({ exit: Type.Number() });

/** Shell commands on the computer through pi-mobile serve's /exec: one WebSocket per command. */
class HostCommands implements CommandClient {
	readonly #host: Pick<Host, "address" | "name">;

	constructor(host: Pick<Host, "address" | "name">) {
		this.#host = host;
	}

	async exec(command: string, handlers: CommandHandlers): Promise<CommandChannel> {
		let exited = false;
		const exit = (code: number | undefined) => {
			if (exited) return;
			exited = true;
			handlers.onExit(code);
		};
		const socket = await openSocket(
			socketUrl(this.#host.address, "/exec", { command }),
			this.#host.name,
			(data) => {
				if (typeof data === "string") {
					try {
						const message: unknown = JSON.parse(data);
						if (Value.Check(ExitMessage, message)) exit(message.exit);
					} catch {
						// Not ours.
					}
					return;
				}
				const bytes = new Uint8Array(data);
				if (bytes[0] === 1) handlers.onStdout(bytes.subarray(1));
				else if (bytes[0] === 2) handlers.onStderr?.(bytes.subarray(1));
			},
			() => exit(undefined),
		);
		return {
			write: (data) => {
				if (socket.readyState === WebSocket.OPEN) socket.send(data.slice());
			},
			end: () => {
				if (socket.readyState === WebSocket.OPEN) socket.send("eof");
			},
			close: () => socket.close(),
		};
	}

	run(command: string, input?: Uint8Array): Promise<{ stdout: string; stderr: string; code: number | undefined }> {
		return new Promise((resolve, reject) => {
			const out: Uint8Array[] = [];
			const err: Uint8Array[] = [];
			const text = (parts: Uint8Array[]) => new TextDecoder().decode(new Uint8Array(parts.flatMap((part) => [...part])));
			this.exec(command, {
				onStdout: (data) => out.push(data.slice()),
				onStderr: (data) => err.push(data.slice()),
				onExit: (code) => resolve({ stdout: text(out), stderr: text(err), code }),
			}).then((channel) => {
				if (input) for (let i = 0; i < input.length; i += 256 * 1024) channel.write(input.subarray(i, i + 256 * 1024));
				channel.end();
			}, reject);
		});
	}
}

/** Preparations in flight or done this app run, by address: the settings, the bot panel, and a bot share one. */
const preparing = new Map<string, { done: Promise<void>; listeners: Set<(detail: string) => void> }>();

/**
 * Build the container images on a host unless they are current: about a second when they are, minutes the first time.
 * Once per app run; `onProgress` gets the build's last line, also when another caller started it.
 */
export function prepareContainers(host: Host, onProgress: (detail: string) => void = () => undefined): Promise<void> {
	if (!host.engine) return Promise.reject(new Error(`${host.name} 沒有 docker、podman 或 nerdctl`));
	let entry = preparing.get(host.address);
	if (!entry) {
		const listeners = new Set<(detail: string) => void>();
		const commands = new HostCommands(host);
		const done = new ContainerHost(host.engine, async () => commands).ensureImages(host.home, (detail) => {
			for (const listener of listeners) listener(detail);
		});
		entry = { done, listeners };
		preparing.set(host.address, entry);
		done.catch(() => preparing.delete(host.address));
	}
	const { done, listeners } = entry;
	listeners.add(onProgress);
	return done.finally(() => listeners.delete(onProgress));
}

export class HostSandbox implements Sandbox {
	readonly kind = "host";
	readonly host: Host;
	readonly mode: HostMode;
	readonly #envs: SharedEnvs;
	readonly #stopBridge: (() => void) | undefined;
	#ready: Promise<string> | undefined;

	constructor(host: Host, mode: HostMode, credentials: Credentials) {
		this.host = host;
		this.mode = mode;
		const onLog = (text: string) => log.warn("sandbox.daemon_output", { host: host.name, text });
		if (mode === "container" && host.engine) {
			const commands = new HostCommands(host);
			const containers = new ContainerHost(host.engine, async () => commands);
			this.#stopBridge = containers.bridge(credentials);
			// Per-service settings from the phone, such as the default Google Cloud project or Cloudflare account.
			const serviceEnv = () => Object.assign({}, ...Object.values(credentials.minted).map((service) => service.env));
			const connection = new StreamConnection({ open: containers.opener(SHARED_SANDBOX, serviceEnv), onLog });
			this.#envs = new SharedEnvs(connection, WORKSPACE, (folder) => `${WORKSPACE}/${folder}`);
		} else {
			this.#envs = new SharedEnvs(new StreamConnection({ open: this.#direct(), onLog }), host.home, () => host.home);
		}
	}

	get direct(): boolean {
		return this.mode === "direct";
	}

	/** pi-env as the user from home: the daemon uploaded when the computer lacks it, once per app run. */
	#direct(): OpenDaemon {
		return async (token, handlers) => {
			const sha = await this.#daemon();
			const socket = await openSocket(
				socketUrl(this.host.address, "/env", { daemon: sha, token }),
				`${this.host.name}（${this.host.address}）`,
				(data) => {
					if (data instanceof ArrayBuffer) handlers.onData(new Uint8Array(data));
				},
				handlers.onClose,
			);
			return {
				send: (data) => {
					if (socket.readyState === WebSocket.OPEN) socket.send(data);
				},
				close: () => socket.close(),
			};
		};
	}

	#daemon(): Promise<string> {
		this.#ready ??= (async () => {
			const info = await probeHost(this.host.address);
			const { bytes, sha } = await daemon(info.os, info.arch);
			if (!info.daemons.includes(sha)) {
				const response = await fetch(`${base(this.host.address)}/daemon/${sha}`, { method: "PUT", body: new Blob([bytes.slice()]) });
				if (!response.ok) throw new Error(`上傳 pi-env 到 ${this.host.name} 失敗：HTTP ${response.status} ${(await response.text()).trim()}`);
			}
			return sha;
		})();
		this.#ready.catch(() => {
			this.#ready = undefined;
		});
		return this.#ready;
	}

	root(folder: string): string {
		return this.direct ? this.host.home : `${WORKSPACE}/${folder}`;
	}

	async env(folder: string): Promise<ExecutionEnv> {
		// The images, built the first time a bot works in this computer's container.
		if (!this.direct) await prepareContainers(this.host, (detail) => log.info("host.prepare", { host: this.host.name, detail }));
		return this.#envs.env(folder);
	}

	exists(folder: string): Promise<boolean> {
		return this.direct ? Promise.resolve(true) : this.#envs.exists(folder);
	}

	remove(folder: string): Promise<void> {
		// Directly, the working directory is the user's home, never deleted from here.
		if (this.direct) return Promise.reject(new Error("直接操作的電腦不會刪除檔案"));
		return this.#envs.remove(folder);
	}

	describe(folder: string): string {
		return this.direct ? directDescription(this.host.name, this.host.user, this.host, "pi-mobile") : containerDescription(folder);
	}

	close(): void {
		this.#stopBridge?.();
		this.#envs.close();
	}
}

/** An MCP server URL that runs on one of the user's computers: computer://<address>?command=<shell command>. */
export const COMPUTER_MCP = "computer:";

export function parseComputerMcp(url: string): { address: string; command: string } | undefined {
	try {
		const parsed = new URL(url);
		const command = parsed.searchParams.get("command");
		return parsed.protocol === COMPUTER_MCP && parsed.hostname && command ? { address: parsed.hostname, command } : undefined;
	} catch {
		return undefined;
	}
}

/**
 * MCP over stdio, the way local servers speak it (newline-delimited JSON-RPC), with the server started on the computer
 * through pi-mobile serve's /exec: so a server that only runs on a desktop, such as computer use, serves the phone,
 * reached only by the user's own devices. One process per connection; it ends when the connection does.
 */
export class HostStdioTransport implements McpTransport {
	readonly #address: string;
	readonly #command: string;
	#channel: CommandChannel | undefined;
	#buffer = "";
	#closed = false;
	readonly #message = new Set<McpTransportMessageListener>();
	readonly #error = new Set<McpTransportErrorListener>();
	readonly #close = new Set<McpTransportCloseListener>();

	constructor(address: string, command: string) {
		this.#address = address;
		this.#command = command;
	}

	async start(): Promise<void> {
		let stderr = "";
		this.#channel = await new HostCommands({ address: this.#address, name: this.#address }).exec(this.#command, {
			onStdout: (data) => {
				this.#buffer += new TextDecoder().decode(data, { stream: true });
				let newline = this.#buffer.indexOf("\n");
				while (newline >= 0) {
					const line = this.#buffer.slice(0, newline).trim();
					this.#buffer = this.#buffer.slice(newline + 1);
					if (line) {
						try {
							const message = parseJsonRpcMessage(JSON.parse(line));
							for (const listener of this.#message) listener(message);
						} catch (error) {
							for (const listener of this.#error) listener(error instanceof Error ? error : new Error(String(error)));
						}
					}
					newline = this.#buffer.indexOf("\n");
				}
			},
			onStderr: (data) => {
				stderr = (stderr + new TextDecoder().decode(data)).slice(-2000);
				log.info("mcp.computer_stderr", { address: this.#address, text: new TextDecoder().decode(data).slice(0, 500) });
			},
			onExit: (code) => {
				if (!this.#closed && code !== 0) {
					const error = new Error(`MCP server on ${this.#address} exited${code === undefined ? "" : ` with ${code}`}: ${stderr.trim().split("\n").slice(-3).join(" / ")}`);
					for (const listener of this.#error) listener(error);
				}
				this.#closed = true;
				for (const listener of this.#close) listener();
			},
		});
	}

	async send(message: JsonRpcMessage): Promise<void> {
		if (!this.#channel || this.#closed) throw new Error("MCP connection to the computer is closed");
		this.#channel.write(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.#channel?.close();
	}

	onMessage(listener: McpTransportMessageListener): () => void {
		this.#message.add(listener);
		return () => this.#message.delete(listener);
	}

	onError(listener: McpTransportErrorListener): () => void {
		this.#error.add(listener);
		return () => this.#error.delete(listener);
	}

	onClose(listener: McpTransportCloseListener): () => void {
		this.#close.add(listener);
		return () => this.#close.delete(listener);
	}
}
