import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { type Static, Type } from "typebox";
import wire from "../../../host/protocol.json" with { type: "json" };

import { type McpTransport, PipeTransport } from "@earendil-works/pi-mcp";
import { log } from "../../log.ts";
import { type CommandChannel, type CommandClient, type CommandHandlers, ContainerHost, type Credentials } from "./container.ts";
import { DAEMON_OSES, daemon } from "./daemon.ts";
import { containerDescription, directDescription, type Sandbox, SharedEnvs } from "./sandbox.ts";
import { deviceNetwork, type Network } from "../network.ts";
import { type ConnectionStatus, lost, type OpenDaemon, PhoneConnection } from "./phone-connection.ts";
import type { RawMessage } from "./resumable-link.ts";
import { type OpenRaw, RESUME_LIMIT_MS, type ResumableOptions, ResumableSocket } from "./resumable-socket.ts";
import { WORKSPACE } from "./workspace.ts";
import { hostTraffic } from "../traffic.ts";
import { decode, decodeEach, oneOf } from "../../parse.ts";
import { onFailure, untilFailure } from "../../promise.ts";
import { onTailnet, refuseIpOnIos, tailscaleHint } from "../cleartext.ts";
import { ios } from "../../native.ts";
import { randomHex } from "../../encoding.ts";

const HOST_PORT = 4790;

const System = {
	os: oneOf(DAEMON_OSES),
	arch: oneOf(["x64", "arm64"]),
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
type HostInfo = Static<typeof HostInfo>;

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

export function pairedHosts(settings: { hosts: readonly Host[]; hostKeys: Record<string, string> }): PairedHost[] {
	return settings.hosts.map((host) => ({ ...host, key: settings.hostKeys[host.id] ?? "" }));
}

export type HostMode = "direct" | "container";

export const computerKey = (hostId: string, mode: HostMode) => `${hostId}:${mode}`;

export function parseComputerKey(key: string): { hostId: string; mode: HostMode } | undefined {
	const at = key.lastIndexOf(":");
	const mode = key.slice(at + 1);
	return at > 0 && (mode === "direct" || mode === "container") ? { hostId: key.slice(0, at), mode } : undefined;
}

export function parseHosts(json: string | undefined): Host[] {
	return decodeEach(Host, json);
}

function base(address: string): string {
	const root = `http://${address.includes(":") ? `[${address}]` : address}:${HOST_PORT}`;
	if (!onTailnet(root)) throw new Error(`${address} 不在 Tailscale 裡：填電腦在 Tailscale 裡的名稱，例如 mac 或 mac.xxxx.ts.net`);
	refuseIpOnIos(root, ios);
	return root;
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
			throw new Error(`連不到 ${address}：電腦要開著、連上 Tailscale，並裝好 pi-mobile${tailscaleHint(ios)}`);
		},
	);
	if (response.status === 401) throw new Error(`${address} 沒有跟這支手機配對：在那台電腦執行 pi-mobile pair，把配對碼輸入設定 › 電腦`);
	if (response.status === 403) throw new Error(`${address} 拒絕了這支手機：手機和電腦要登入同一個 Tailscale 帳號`);
	return response;
}

const PairAnswer = Type.Object({ key: Type.String() });

export async function pairHost(address: string, code: string): Promise<string> {
	const response = await reached(address, fetch(`${base(address)}/pair?code=${encodeURIComponent(code)}`, { method: "POST", signal: AbortSignal.timeout(15_000) }));
	if (response.status === 410) throw new Error(`${address} 沒有等待中的配對碼：在那台電腦執行 pi-mobile pair`);
	if (response.status === 422) throw new Error("配對碼不對；錯 5 次要在電腦上重新執行 pi-mobile pair");
	if (!response.ok) throw new Error(`${address} 回應 HTTP ${response.status}：${(await response.text()).trim()}`);
	const answer = decode(PairAnswer, await response.text());
	if (!answer) throw new Error(`${address} 的回應看不懂，電腦上的 pi-mobile 可能要更新`);
	return answer.key;
}

export async function unpairHost(host: Reach): Promise<void> {
	const response = await reached(host.address, fetch(url(host, "/unpair"), { method: "DELETE", signal: AbortSignal.timeout(8000) }));
	if (response.status === 204) return;
	const body = (await response.text()).trim();
	if (response.status === 404 && body.includes("not paired")) return;
	if (response.status === 404 || response.status === 405) throw new Error(`${host.address} 上的 pi-mobile 太舊，不會撤銷配對：更新它之後執行 pi-mobile pair 重新配對，或刪掉 ~/.pi/mobile/paired.json`);
	throw new Error(`${host.address} 回應 HTTP ${response.status}：${body}`);
}

export async function stillPaired(reach: Reach, signal: AbortSignal): Promise<boolean> {
	const response = await fetch(url(reach, "/info"), { signal });
	return response.status !== 401;
}

export async function hasPiMobile(address: string, signal: AbortSignal): Promise<boolean> {
	return fetch(`${base(address)}/version`, { signal }).then(
		(response) => response.ok,
		() => false,
	);
}

export async function probeHost(reach: Reach, signal?: AbortSignal): Promise<HostInfo> {
	const response = await reached(reach.address, fetch(url(reach, "/info"), { signal: signal ?? AbortSignal.timeout(15_000) }));
	if (!response.ok) throw new Error(`${reach.address} 回應 HTTP ${response.status}：${(await response.text()).trim()}`);
	const info = decode(HostInfo, await response.text());
	if (!info) throw new Error(`${reach.address} 的回應看不懂，電腦上的 pi-mobile 可能要更新`);
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

const Peer = Type.Object({ name: Type.String(), dnsName: Type.String(), os: System.os });
export type Peer = Static<typeof Peer>;

export async function listPeers(host: Reach): Promise<Peer[]> {
	const response = await fetch(url(host, "/peers"), { signal: AbortSignal.timeout(8000) });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return decodeEach(Peer, await response.text());
}

export type Dial = { open: OpenRaw; network: Network };

const deviceDial: Dial = { open: openSocket, network: deviceNetwork };

function holdSocket(
	reach: Reach,
	what: string,
	path: "/exec" | "/env",
	first: Record<string, string>,
	token: string,
	dial: Dial,
	handlers: Pick<ResumableOptions, "onMessage" | "onClose" | "onLink">,
): Promise<ResumableSocket> {
	return ResumableSocket.connect({
		quietLimitMs: wire.quietSeconds * 1000,
		resumeLimitMs: RESUME_LIMIT_MS,
		traffic: hostTraffic(reach.address),
		first: socketUrl(reach, path, first),
		attach: (received) => socketUrl(reach, path, { attach: token, received: String(received) }),
		...dial,
		what,
		...handlers,
	}).catch((error: unknown) => explained(reach, error));
}

// why: a WebView WebSocket that fails its handshake reports no HTTP status, so a refused key looks like a lost network until /info says which.
async function explained(reach: Reach, error: unknown): Promise<never> {
	await probeHost(reach, AbortSignal.timeout(5000));
	throw error;
}

function openSocket(url: URL, what: string, onMessage: (data: RawMessage) => void, onClose: (reason: string | undefined) => void): Promise<WebSocket> {
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

export class HostCommands implements CommandClient {
	readonly #host: Pick<PairedHost, "address" | "name" | "key">;
	readonly #dial: Dial;

	constructor(host: Pick<PairedHost, "address" | "name" | "key">, dial = deviceDial) {
		this.#host = host;
		this.#dial = dial;
	}

	async exec(command: string, handlers: CommandHandlers, daemonToken?: string): Promise<CommandChannel> {
		let exited = false;
		const opened = Promise.withResolvers<ResumableSocket>();
		const exit = (code: number | undefined) => {
			if (exited) return;
			exited = true;
			if (code !== undefined) void opened.promise.then((socket) => socket.close());
			handlers.onExit(code);
		};
		const session = daemonToken ?? randomHex(16);
		const resumable = await holdSocket(this.#host, this.#host.name, "/exec", { command, session, ...(daemonToken ? { heartbeat: wire.heartbeat } : {}) }, session, this.#dial, {
			onMessage: (data) => {
				if (typeof data === "string") {
					const message = decode(ExitMessage, data);
					if (message) exit(message.exit);
					return;
				}
				const bytes = new Uint8Array(data);
				if (bytes[0] === wire.stdout) handlers.onStdout(bytes.subarray(1));
				else if (bytes[0] === wire.stderr) handlers.onStderr?.(bytes.subarray(1));
			},
			onClose: () => exit(undefined),
			...(handlers.onLink ? { onLink: handlers.onLink } : {}),
		});
		opened.resolve(resumable);
		return {
			write: (data) => resumable.send(data.slice()),
			end: () => resumable.send(wire.endOfInput),
			close: () => resumable.close(),
		};
	}

	run(command: string, input?: Uint8Array): Promise<{ stdout: string; stderr: string; code: number | undefined }> {
		return new Promise((resolve, reject) => {
			const out: Uint8Array[] = [];
			const err: Uint8Array[] = [];
			const text = (parts: Uint8Array[]) => {
				const decoder = new TextDecoder();
				return parts.map((part) => decoder.decode(part, { stream: true })).join("") + decoder.decode();
			};
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

type Preparing = { done: Promise<void>; listeners: Set<(detail: string) => void> };

const preparing = new Map<string, Preparing>();

function follow(entry: Preparing, onProgress: (detail: string) => void): Promise<void> {
	entry.listeners.add(onProgress);
	return entry.done.finally(() => entry.listeners.delete(onProgress));
}

export function watchPrepare(host: PairedHost, onProgress: (detail: string) => void): Promise<void> | undefined {
	const entry = preparing.get(host.address);
	return entry ? follow(entry, onProgress) : undefined;
}

export function prepareContainers(host: PairedHost, onProgress: (detail: string) => void): Promise<void> {
	if (!host.engine) return Promise.reject(new Error(`${host.name} 沒有 docker、podman 或 nerdctl`));
	const known = preparing.get(host.address);
	if (known) return follow(known, onProgress);
	const listeners = new Set<(detail: string) => void>();
	const done = new ContainerHost(host.engine, new HostCommands(host), host.home).ensureImages((detail) => {
		for (const listener of listeners) listener(detail);
	});
	const entry = { done, listeners };
	preparing.set(host.address, entry);
	onFailure(done, () => preparing.delete(host.address));
	return follow(entry, onProgress);
}

export class HostSandbox implements Sandbox {
	readonly host: PairedHost;
	readonly direct: boolean;
	readonly #envs: SharedEnvs;
	readonly #startBridge: (() => () => void) | undefined;
	#stopBridge: (() => void) | undefined;
	#status: ConnectionStatus = { kind: "idle" };
	readonly #listeners = new Set<(status: ConnectionStatus) => void>();

	constructor(host: PairedHost, mode: HostMode, credentials: Credentials) {
		this.host = host;
		const engine = mode === "container" ? host.engine : undefined;
		this.direct = !engine;
		const onLog = (text: string) => log.warn("sandbox.daemon_output", { host: host.name, text });
		const onStatus = (status: ConnectionStatus) => {
			this.#status = status;
			log.info("host.connection", { host: host.name, mode, status: status.kind, ...(status.kind === "lost" ? { reason: status.reason } : {}) });
			for (const listener of this.#listeners) listener(status);
		};
		if (engine) {
			const containers = new ContainerHost(engine, new HostCommands(host), host.home);
			this.#startBridge = () => containers.bridge(credentials);
			const serviceEnv = () => Object.assign({}, ...Object.values(credentials.minted).map((service) => service.env));
			const connection = new PhoneConnection({ open: containers.opener(serviceEnv), onLog, onStatus });
			this.#envs = new SharedEnvs(connection, WORKSPACE, (folder) => `${WORKSPACE}/${folder}`);
		} else {
			this.#envs = new SharedEnvs(new PhoneConnection({ open: this.#direct(), onLog, onStatus }), host.home, () => host.home);
		}
	}

	get status(): ConnectionStatus {
		return this.#status;
	}

	subscribe(listener: (status: ConnectionStatus) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#direct(): OpenDaemon {
		return async (token, handlers) => {
			const sha = await this.#daemon();
			const socket = await holdSocket(this.host, `${this.host.name}（${this.host.address}）`, "/env", { daemon: sha, token }, token, deviceDial, {
				onMessage: (data) => {
					if (data instanceof ArrayBuffer) handlers.onData(new Uint8Array(data));
				},
				onClose: handlers.onClose,
				onLink: handlers.onLink,
			});
			return { send: (data) => socket.send(data), close: () => socket.close() };
		};
	}

	readonly #daemon = untilFailure(async () => {
		const info = await probeHost(this.host);
		const { bytes, sha } = daemon(info.os, info.arch);
		if (!info.daemons.includes(sha)) {
			const response = await fetch(url(this.host, `/daemon/${sha}`), { method: "PUT", body: new Blob([await bytes()]) });
			if (!response.ok) throw new Error(`上傳 pi-env 到 ${this.host.name} 失敗：HTTP ${response.status} ${(await response.text()).trim()}`);
		}
		return sha;
	});

	root(folder: string): string {
		return this.#envs.root(folder);
	}

	async env(folder: string): Promise<ExecutionEnv> {
		if (!this.direct) await prepareContainers(this.host, (detail) => log.info("host.prepare", { host: this.host.name, detail }));
		if (this.#startBridge && !this.#stopBridge) this.#stopBridge = this.#startBridge();
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
		return this.direct ? directDescription(this.host) : containerDescription(folder);
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

export function hostStdio(reach: Reach, command: string, dial = deviceDial): McpTransport {
	const transport: PipeTransport = new PipeTransport({
		onStderr: (text) => log.info("mcp.computer_stderr", { address: reach.address, text: text.slice(0, 500) }),
		open: async ({ onStdout, onStderr }) => {
			const exited = Promise.withResolvers<void>();
			const channel = await new HostCommands({ ...reach, name: reach.address }, dial).exec(command, {
				onStdout,
				onStderr,
				onExit: (code) => {
					if (code === 0) return exited.resolve();
					exited.reject(new Error(`MCP server on ${reach.address} exited${code === undefined ? "" : ` with ${code}`}: ${transport.stderr.trim().split("\n").slice(-3).join(" / ")}`));
				},
			});
			return {
				write: (data) => channel.write(typeof data === "string" ? new TextEncoder().encode(data) : data),
				closeStdin: () => channel.end(),
				close: () => {
					channel.close();
					exited.resolve();
				},
				exited: exited.promise,
			};
		},
	});
	return transport;
}
