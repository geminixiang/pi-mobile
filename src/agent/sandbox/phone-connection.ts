import { Buffer } from "buffer";
import { Type } from "typebox";
import { Connection, RemoteError, type RemoteInfo, type Reply, type RequestOptions } from "@earendil-works/pi-env";
import { check } from "../parse.ts";
import { messageOf } from "../../promise.ts";
import { registerProgram } from "../../shims/node-child-process.ts";

type Json = Record<string, unknown>;

export type ConnectionStatus =
	| { kind: "idle" }
	| { kind: "connecting" }
	| { kind: "connected"; session: number }
	| { kind: "reattaching"; session: number; since: number }
	| { kind: "lost"; reason: string; at: number }
	| { kind: "closed" };

interface DaemonStream {
	send(data: Uint8Array<ArrayBuffer>): void;
	close(): void;
}

interface StreamHandlers {
	onData(data: Uint8Array): void;
	onClose(reason?: string): void;
	onLink(up: boolean): void;
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
// why: pi-env's wire format, a daemon ping (type 6, id 0, JSON {}); pi-env's Connection drops a daemon after 30 s without bytes, so while the link is down and the computer holds the daemon, the phone stands in for its pings.
const DAEMON_PING = Buffer.from([0, 0, 0, 11, 6, 0, 0, 0, 0, 0, 0, 0, 2, 0x7b, 0x7d]);

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

class DaemonProcess extends Events {
	readonly stdout = new Events();
	readonly stderr = new Events();
	readonly #session: number;
	readonly #marker: Buffer;
	readonly #report: (status: ConnectionStatus) => void;
	#stream: DaemonStream | undefined;
	#queued: Uint8Array<ArrayBuffer>[] = [];
	#held: Uint8Array[] = [];
	#heldBytes = 0;
	#need = 0;
	#synced = false;
	#pings: ReturnType<typeof setInterval> | undefined;
	#failure: string | undefined;
	#exited = false;
	readonly stdin = {
		write: (data: Uint8Array) => {
			const bytes = ownsArrayBuffer(data) ? data : new Uint8Array(data);
			if (this.#stream) this.#stream.send(bytes);
			else this.#queued.push(bytes);
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
		open(token, { onData: (data) => this.#onData(data), onClose: (reason) => this.end(reason ?? "the computer closed the connection"), onLink: (up) => this.#onLink(up) }).then(
			(stream) => {
				if (this.#exited) return stream.close();
				this.#stream = stream;
				for (const data of this.#queued) stream.send(data);
				this.#queued = [];
			},
			(error: unknown) => {
				this.#failure = messageOf(error);
				this.emit("error", lost(this.#failure));
				this.end(this.#failure);
			},
		);
	}

	kill(): void {
		this.end(this.#failure ?? "the phone closed the connection");
	}

	end(reason: string): void {
		if (this.#exited) return;
		this.#exited = true;
		clearInterval(this.#pings);
		this.#stream?.close();
		this.#held = [];
		this.#queued = [];
		this.#report({ kind: "lost", reason, at: Date.now() });
		this.stderr.emit("data", Buffer.from(reason, "utf8"));
		this.emit("exit", null);
	}

	#onData(data: Uint8Array): void {
		if (this.#exited) return;
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
			this.#report({ kind: "connected", session: this.#session });
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

	#onLink(up: boolean): void {
		if (this.#exited) return;
		clearInterval(this.#pings);
		this.#pings = up ? undefined : setInterval(() => this.#synced && this.stdout.emit("data", DAEMON_PING), PING_EVERY_MS);
		this.#report(up ? { kind: "connected", session: this.#session } : { kind: "reattaching", session: this.#session, since: Date.now() });
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
