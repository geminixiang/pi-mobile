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
import { decode } from "../parse.ts";
import { onFailure } from "../../promise.ts";

const HOST_PORT = 4790;

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
	name: Type.String(),
	address: Type.String(),
	...System,
	user: Type.String(),
	home: Type.String(),
	engine: Type.Optional(Type.String()),
});
export type Host = Static<typeof Host>;

export type PairedHost = Host & { key: string };
type Reach = Pick<PairedHost, "address" | "key">;

export function pairedHosts(settings: { hosts: string; hostKeys: Record<string, string> }): PairedHost[] {
	return parseHosts(settings.hosts).map((host) => ({ ...host, key: settings.hostKeys[host.id] ?? "" }));
}

export type HostMode = "direct" | "container";

export function parseHosts(json: string): Host[] {
	return (decode(Type.Array(Type.Unknown()), json) ?? []).filter((item): item is Host => Value.Check(Host, item));
}

function base(address: string): string {
	return `http://${address.includes(":") ? `[${address}]` : address}:${HOST_PORT}`;
}

// why: a WebSocket from the WebView cannot carry headers, so the pairing key rides in the query on every request alike.
function url(reach: Reach, path: string, params: Record<string, string> = {}): URL {
	const target = new URL(path, base(reach.address));
	for (const [key, value] of Object.entries({ ...params, key: reach.key })) target.searchParams.set(key, value);
	return target;
}

function socketUrl(reach: Reach, path: string, params: Record<string, string>): URL {
	const target = url(reach, path, params);
	target.protocol = "ws:";
	return target;
}

async function reached(address: string, request: Promise<Response>): Promise<Response> {
	const response = await request.then(
		(ok) => ok,
		() => {
			throw new Error(`連不到 ${address}：電腦要開著、連上 Tailscale，並裝好 pi-mobile`);
		},
	);
	if (response.status === 401) throw new Error(`${address} 還沒跟這支手機配對：在那台電腦執行 pi-mobile pair，把配對碼輸入手機`);
	if (response.status === 403) throw new Error(`${address} 拒絕了這支手機：手機和電腦要登入同一個 Tailscale 帳號`);
	return response;
}

const PairAnswer = Type.Object({ key: Type.String() });

export async function pairHost(address: string, code: string): Promise<string> {
	const response = await reached(address, fetch(`${base(address)}/pair?code=${encodeURIComponent(code)}`, { method: "POST", signal: AbortSignal.timeout(15_000) }));
	if (response.status === 410) throw new Error(`${address} 沒有等待中的配對碼：在那台電腦執行 pi-mobile pair`);
	if (response.status === 422) throw new Error("配對碼不對；錯 5 次要在電腦上重新執行 pi-mobile pair");
	if (!response.ok) throw new Error(`${address} 回應 HTTP ${response.status}：${(await response.text()).trim()}`);
	const answer: unknown = await response.json();
	if (!Value.Check(PairAnswer, answer)) throw new Error(`${address} 的回應看不懂，電腦上的 pi-mobile 可能要更新`);
	return answer.key;
}

export async function hasPiMobile(address: string, signal: AbortSignal): Promise<boolean> {
	const response = await fetch(`${base(address)}/version`, { signal }).catch(() => undefined);
	return response?.ok ?? false;
}

export async function probeHost(reach: Reach, signal?: AbortSignal): Promise<HostInfo> {
	const response = await reached(reach.address, fetch(url(reach, "/info"), { signal: signal ?? AbortSignal.timeout(15_000) }));
	if (!response.ok) throw new Error(`${reach.address} 回應 HTTP ${response.status}：${(await response.text()).trim()}`);
	const info: unknown = await response.json();
	if (!Value.Check(HostInfo, info)) throw new Error(`${reach.address} 的回應看不懂，電腦上的 pi-mobile 可能要更新`);
	return info;
}

export function hostFrom(address: string, info: HostInfo, known?: Host): Host {
	const engine = info.engines[0];
	return {
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

export async function listPeers(host: Reach): Promise<Peer[]> {
	const response = await fetch(url(host, "/peers"), { signal: AbortSignal.timeout(8000) });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const peers: unknown = await response.json();
	return Value.Check(Peers, peers) ? peers : [];
}

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

class HostCommands implements CommandClient {
	readonly #host: Pick<PairedHost, "address" | "name" | "key">;

	constructor(host: Pick<PairedHost, "address" | "name" | "key">) {
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
			socketUrl(this.#host, "/exec", { command }),
			this.#host.name,
			(data) => {
				if (typeof data === "string") {
					const message = decode(ExitMessage, data);
					if (message) exit(message.exit);
					return;
				}
				const bytes = new Uint8Array(data);
				if (bytes[0] === 1) handlers.onStdout(bytes.subarray(1));
				else if (bytes[0] === 2) handlers.onStderr?.(bytes.subarray(1));
			},
			() => exit(undefined),
		).catch(async (error: unknown) => {
			await probeHost(this.#host, AbortSignal.timeout(5000));
			throw error;
		});
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

const preparing = new Map<string, { done: Promise<void>; listeners: Set<(detail: string) => void> }>();

export function prepareContainers(host: PairedHost, onProgress: (detail: string) => void = () => undefined): Promise<void> {
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
		onFailure(done, () => preparing.delete(host.address));
	}
	const { done, listeners } = entry;
	listeners.add(onProgress);
	return done.finally(() => listeners.delete(onProgress));
}

export class HostSandbox implements Sandbox {
	readonly kind = "host";
	readonly host: PairedHost;
	readonly mode: HostMode;
	readonly #envs: SharedEnvs;
	readonly #stopBridge: (() => void) | undefined;
	#ready: Promise<string> | undefined;

	constructor(host: PairedHost, mode: HostMode, credentials: Credentials) {
		this.host = host;
		this.mode = mode;
		const onLog = (text: string) => log.warn("sandbox.daemon_output", { host: host.name, text });
		if (mode === "container" && host.engine) {
			const commands = new HostCommands(host);
			const containers = new ContainerHost(host.engine, async () => commands);
			this.#stopBridge = containers.bridge(credentials);
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

	#direct(): OpenDaemon {
		return async (token, handlers) => {
			const sha = await this.#daemon();
			const socket = await openSocket(
				socketUrl(this.host, "/env", { daemon: sha, token }),
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
			const info = await probeHost(this.host);
			const { bytes, sha } = await daemon(info.os, info.arch);
			if (!info.daemons.includes(sha)) {
				const response = await fetch(url(this.host, `/daemon/${sha}`), { method: "PUT", body: new Blob([bytes.slice()]) });
				if (!response.ok) throw new Error(`上傳 pi-env 到 ${this.host.name} 失敗：HTTP ${response.status} ${(await response.text()).trim()}`);
			}
			return sha;
		})();
		onFailure(this.#ready, () => {
			this.#ready = undefined;
		});
		return this.#ready;
	}

	root(folder: string): string {
		return this.direct ? this.host.home : `${WORKSPACE}/${folder}`;
	}

	async env(folder: string): Promise<ExecutionEnv> {
		if (!this.direct) await prepareContainers(this.host, (detail) => log.info("host.prepare", { host: this.host.name, detail }));
		return this.#envs.env(folder);
	}

	exists(folder: string): Promise<boolean> {
		return this.direct ? Promise.resolve(true) : this.#envs.exists(folder);
	}

	remove(folder: string): Promise<void> {
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

const COMPUTER_MCP = "computer:";

export function parseComputerMcp(url: string): { address: string; command: string } | undefined {
	if (!URL.canParse(url)) return undefined;
	const parsed = new URL(url);
	const command = parsed.searchParams.get("command");
	return parsed.protocol === COMPUTER_MCP && parsed.hostname && command ? { address: parsed.hostname, command } : undefined;
}

export class HostStdioTransport implements McpTransport {
	readonly #reach: Reach;
	readonly #command: string;
	#channel: CommandChannel | undefined;
	#buffer = "";
	#closed = false;
	readonly #message = new Set<McpTransportMessageListener>();
	readonly #error = new Set<McpTransportErrorListener>();
	readonly #close = new Set<McpTransportCloseListener>();

	constructor(reach: Reach, command: string) {
		this.#reach = reach;
		this.#command = command;
	}

	async start(): Promise<void> {
		let stderr = "";
		this.#channel = await new HostCommands({ ...this.#reach, name: this.#reach.address }).exec(this.#command, {
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
				log.info("mcp.computer_stderr", { address: this.#reach.address, text: new TextDecoder().decode(data).slice(0, 500) });
			},
			onExit: (code) => {
				if (!this.#closed && code !== 0) {
					const error = new Error(`MCP server on ${this.#reach.address} exited${code === undefined ? "" : ` with ${code}`}: ${stderr.trim().split("\n").slice(-3).join(" / ")}`);
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
