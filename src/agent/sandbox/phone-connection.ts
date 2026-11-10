import { Buffer } from "buffer";
import { Type } from "typebox";
import { Connection, RemoteError, type RemoteInfo, type Reply, type RequestOptions } from "@earendil-works/pi-env";
import wire from "../../../host/protocol.json" with { type: "json" };
import { check } from "../../parse.ts";
import { messageOf } from "../../promise.ts";
import { registerProgram } from "../../shims/node-child-process.ts";
import type { Link } from "./resumable-socket.ts";

type Json = Record<string, unknown>;

export type ConnectionStatus =
	| { kind: "idle" }
	| { kind: "connecting" }
	| { kind: "connected"; session: number }
	| { kind: "reattaching"; session: number; since: number }
	| { kind: "offline"; session: number; since: number }
	| { kind: "lost"; reason: string; at: number }
	| { kind: "closed" };

interface DaemonStream {
	send(data: Uint8Array<ArrayBuffer>): void;
	close(): void;
}

interface StreamHandlers {
	onData(data: Uint8Array): void;
	onClose(reason?: string): void;
	onLink(link: Link): void;
}

export type OpenDaemon = (token: string, handlers: StreamHandlers) => Promise<DaemonStream>;

type PhoneOptions = { open: OpenDaemon; onLog: (text: string) => void; onStatus: (status: ConnectionStatus) => void };

export function lost(message: string): RemoteError {
	return new RemoteError({ code: "unknown", message, lost: true });
}

const Hello = Type.Object({
	protocol: Type.Literal(1),
	version: Type.String(),
	os: Type.String(),
	arch: Type.String(),
	home: Type.String(),
	tmpdir: Type.String(),
	separator: Type.String(),
	cwd: Type.String(),
	driveCwds: Type.Record(Type.String(), Type.String()),
	pid: Type.Number(),
	features: Type.Optional(Type.Array(Type.String())),
});

const MAX_FRAME = 16 * 1024 * 1024 + 64;
const PING_EVERY_MS = 5000;
// why: pi-env's Connection drops a daemon after 30 s without bytes, so while the link is down and the computer holds the daemon, the phone stands in for its pings.
const DAEMON_PING = Buffer.from(wire.piEnvPing);

function ownsArrayBuffer(data: Uint8Array): data is Uint8Array<ArrayBuffer> {
	return data.buffer instanceof ArrayBuffer;
}

function joined(chunks: Uint8Array[], length: number): Buffer {
	const [only] = chunks;
	return chunks.length === 1 && only ? Buffer.from(only.buffer, only.byteOffset, only.byteLength) : Buffer.concat(chunks, length);
}

type Listener = (...args: unknown[]) => void;

class Events {
	readonly #listeners = new Map<string, Listener[]>();

	on(event: string, listener: Listener): this {
		this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
		return this;
	}

	once(event: string, listener: Listener): this {
		const wrapped: Listener = (...args) => {
			this.#listeners.set(event, (this.#listeners.get(event) ?? []).filter((candidate) => candidate !== wrapped));
			listener(...args);
		};
		return this.on(event, wrapped);
	}

	emit(event: string, ...args: unknown[]): void {
		for (const listener of this.#listeners.get(event) ?? []) listener(...args);
	}
}

class TextStream extends Events {
	setEncoding(): this {
		return this;
	}
}

type Pipe = { kind: "opening"; queued: Uint8Array<ArrayBuffer>[] } | { kind: "open"; stream: DaemonStream } | { kind: "failed"; reason: string } | { kind: "ended" };

type Line = { kind: "up" } | { kind: "down"; link: Exclude<Link, "up">; since: number; pings: ReturnType<typeof setInterval> };

class DaemonProcess extends Events {
	readonly stdout = new Events();
	readonly stderr = new TextStream();
	readonly #session: number;
	readonly #marker: Buffer;
	readonly #report: (status: ConnectionStatus) => void;
	#pipe: Pipe = { kind: "opening", queued: [] };
	#line: Line = { kind: "up" };
	#held: Uint8Array[] = [];
	#heldBytes = 0;
	#need = 0;
	#synced = false;
	readonly stdin = {
		write: (data: Uint8Array) => {
			const bytes = ownsArrayBuffer(data) ? data : new Uint8Array(data);
			if (this.#pipe.kind === "open") this.#pipe.stream.send(bytes);
			else if (this.#pipe.kind === "opening") this.#pipe.queued.push(bytes);
		},
		end: () => undefined,
		on: () => undefined,
	};

	constructor(token: string, session: number, open: OpenDaemon, report: (status: ConnectionStatus) => void) {
		super();
		this.#session = session;
		this.#marker = Buffer.from(`PI-ENV ${token}\n`, "utf8");
		this.#report = report;
		report({ kind: "connecting" });
		open(token, { onData: (data) => this.#onData(data), onClose: (reason) => this.end(reason ?? "the computer closed the connection"), onLink: (link) => this.#onLink(link) }).then(
			(stream) => {
				if (this.#pipe.kind !== "opening") return stream.close();
				const { queued } = this.#pipe;
				this.#pipe = { kind: "open", stream };
				for (const data of queued) stream.send(data);
			},
			(error: unknown) => {
				if (this.#pipe.kind !== "opening") return;
				const reason = messageOf(error);
				this.#pipe = { kind: "failed", reason };
				this.emit("error", lost(reason));
				this.end(reason);
			},
		);
	}

	kill(): void {
		this.end(this.#pipe.kind === "failed" ? this.#pipe.reason : "the phone closed the connection");
	}

	end(reason: string): void {
		const pipe = this.#pipe;
		if (pipe.kind === "ended") return;
		this.#pipe = { kind: "ended" };
		if (this.#line.kind === "down") clearInterval(this.#line.pings);
		if (pipe.kind === "open") pipe.stream.close();
		this.#held = [];
		this.#report({ kind: "lost", reason, at: Date.now() });
		this.stderr.emit("data", reason);
		this.emit("exit", null);
	}

	#status(): ConnectionStatus {
		if (this.#line.kind === "down") return { kind: this.#line.link, session: this.#session, since: this.#line.since };
		return this.#synced ? { kind: "connected", session: this.#session } : { kind: "connecting" };
	}

	#onData(data: Uint8Array): void {
		if (this.#pipe.kind === "ended") return;
		this.#held.push(data);
		this.#heldBytes += data.byteLength;
		if (this.#heldBytes < this.#need) return;
		const pending = joined(this.#held, this.#heldBytes);
		let end = 0;
		if (!this.#synced) {
			const index = pending.indexOf(this.#marker);
			if (index === -1) {
				this.#held = [pending];
				return;
			}
			end = index + this.#marker.length;
			this.#synced = true;
			if (this.#line.kind === "up") this.#report(this.#status());
		}
		while (pending.length - end >= 4) {
			const length = pending.readUInt32BE(end);
			if (length > MAX_FRAME) {
				end = pending.length;
				break;
			}
			if (pending.length - end < 4 + length) break;
			end += 4 + length;
		}
		if (end > 0) this.stdout.emit("data", pending.subarray(0, end));
		const rest = pending.subarray(end);
		this.#held = rest.length > 0 ? [new Uint8Array(rest)] : [];
		this.#heldBytes = rest.length;
		this.#need = rest.length >= 4 ? 4 + rest.readUInt32BE(0) : 4;
	}

	#onLink(link: Link): void {
		if (this.#pipe.kind === "ended") return;
		if (this.#line.kind === "down") clearInterval(this.#line.pings);
		this.#line =
			link === "up"
				? { kind: "up" }
				: { kind: "down", link, since: Date.now(), pings: setInterval(() => this.#synced && this.stdout.emit("data", DAEMON_PING), PING_EVERY_MS) };
		this.#report(this.#status());
	}
}

class Transport {
	readonly #options: PhoneOptions;
	readonly #registration = registerProgram((args) => this.#spawn(args));
	#sessions = 0;
	child: DaemonProcess | undefined;
	lastLoss = "";

	constructor(options: PhoneOptions) {
		this.#options = options;
	}

	get program(): string {
		return this.#registration.program;
	}

	report(status: ConnectionStatus): void {
		if (status.kind === "lost") this.lastLoss = status.reason;
		this.#options.onStatus(status);
	}

	dispose(): void {
		this.#registration.dispose();
	}

	#spawn(args: readonly string[]): DaemonProcess {
		this.child = new DaemonProcess(args[args.indexOf("--token") + 1] ?? "", ++this.#sessions, this.#options.open, (status) => this.report(status));
		return this.child;
	}
}

export class PhoneConnection extends Connection {
	readonly #transport: Transport;

	constructor(options: PhoneOptions) {
		const transport = new Transport(options);
		super({ command: [transport.program], onLog: options.onLog });
		this.#transport = transport;
	}

	override async info(): Promise<RemoteInfo> {
		const info = await super.info().catch((error: unknown) => {
			throw this.#explained(error, false);
		});
		const hello = check(Hello, info, "pi-env hello");
		if (hello.ok) return hello.value;
		this.#transport.child?.end(hello.problem);
		throw lost(hello.problem);
	}

	override async request(op: string, json: Json, options: RequestOptions = {}): Promise<Reply> {
		let sent = false;
		try {
			return await super.request(op, json, {
				...options,
				onStart: (id, session) => {
					sent = true;
					options.onStart?.(id, session);
				},
			});
		} catch (error) {
			throw this.#explained(error, sent);
		}
	}

	override close(): void {
		super.close();
		this.#transport.dispose();
		this.#transport.report({ kind: "closed" });
	}

	#explained(error: unknown, sent: boolean): unknown {
		if (!(error instanceof RemoteError) || error.fields.lost !== true) return error;
		const reason = this.#transport.lastLoss;
		const message = reason && !error.message.includes(reason) ? `${error.message}: ${reason}` : error.message;
		return sent
			? new RemoteError({ ...error.fields, message: `${message}; the request had been sent, so its outcome is unknown: check before retrying`, outcome: "unknown" })
			: new RemoteError({ ...error.fields, message: `${message} before the request was sent`, outcome: "unsent" });
	}
}
