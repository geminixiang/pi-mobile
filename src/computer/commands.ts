import { type McpTransport, PipeTransport } from "@earendil-works/pi-mcp";
import { RemoteError } from "@earendil-works/pi-env";
import { Type } from "typebox";
import wire from "../../host/protocol.json" with { type: "json" };
import { log } from "../log.ts";
import { decode } from "../parse.ts";
import { randomHex } from "../encoding.ts";
import { deviceNetwork, type Network } from "../agent/network.ts";
import { hostTraffic } from "../agent/traffic.ts";
import type { Link, RawMessage } from "./resumable-link.ts";
import { type OpenRaw, RESUME_LIMIT_MS, type ResumableOptions, ResumableSocket } from "./resumable-socket.ts";
import { type PairedHost, probeHost, type Reach, socketUrl } from "./pairing.ts";

export interface CommandHandlers {
	onStdout(data: Uint8Array): void;
	onStderr?(data: Uint8Array): void;
	onExit(code: number | undefined): void;
	onLink?(link: Link): void;
}

export interface CommandChannel {
	write(data: Uint8Array): void;
	end(): void;
	close(): void;
}

export interface CommandClient {
	exec(command: string, handlers: CommandHandlers, daemonToken?: string): Promise<CommandChannel>;
	run(command: string, input?: Uint8Array): Promise<{ stdout: string; stderr: string; code: number | undefined }>;
}

export function lost(message: string): RemoteError {
	return new RemoteError({ code: "unknown", message, lost: true });
}

export type Dial = { open: OpenRaw; network: Network };

export const deviceDial: Dial = { open: openSocket, network: deviceNetwork };

export function holdSocket(
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
