import { Type } from "typebox";
import { RemoteError, type RemoteInfo, type Reply, type RequestOptions } from "@earendil-works/pi-env";
import { check, decode } from "../parse.ts";
import { settled, onFailure } from "../../promise.ts";
import { randomHex } from "../../encoding.ts";

type Json = Record<string, unknown>;
const FrameJson = Type.Record(Type.String(), Type.Unknown());
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

const REQUEST = 1;
const RESULT = 2;
const ERROR = 3;
const EVENT = 4;
const CANCEL = 5;
const PING = 6;

const MAX_FRAME = 16 * 1024 * 1024;
const PING_INTERVAL_MS = 5000;
const SILENCE_LIMIT_MS = 30_000;
const START_TIMEOUT_MS = 60_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function wellFormed(_key: string, value: unknown): unknown {
	return typeof value === "string" ? value.toWellFormed() : value;
}

function frame(type: number, id: number, json: Json, payload: Uint8Array = new Uint8Array(0)): Uint8Array<ArrayBuffer> {
	const body = encoder.encode(JSON.stringify(json, wellFormed));
	const out = new Uint8Array(13 + body.length + payload.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, 9 + body.length + payload.length);
	view.setUint8(4, type);
	view.setUint32(5, id);
	view.setUint32(9, body.length);
	out.set(body, 13);
	out.set(payload, 13 + body.length);
	return out;
}

export function lost(message: string): RemoteError {
	return new RemoteError({ code: "unknown", message, lost: true });
}

function unsent(): RemoteError {
	return new RemoteError({ code: "unknown", message: "pi-env connection lost before the request was sent", lost: true, outcome: "unsent" });
}

function unknownOutcome(cause: RemoteError): RemoteError {
	return new RemoteError({ ...cause.fields, message: `${cause.message}; the request had been sent, so its outcome is unknown: check before retrying`, outcome: "unknown" });
}

function closed(): RemoteError {
	return new RemoteError({ code: "unknown", message: "Connection closed" });
}

export type ConnectionStatus =
	| { kind: "idle" }
	| { kind: "connecting" }
	| { kind: "connected"; session: number }
	| { kind: "reattaching"; session: number; since: number }
	| { kind: "lost"; reason: string; at: number }
	| { kind: "closed" };

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
	outer: for (let i = 0; i < haystack.length - needle.length + 1; i++) {
		for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
		return i;
	}
	return -1;
}

interface DaemonStream {
	send(data: Uint8Array<ArrayBuffer>): void;
	close(): void;
	retry?(): void;
}

interface StreamHandlers {
	onData(data: Uint8Array): void;
	onClose(reason?: string): void;
	onLink?(up: boolean): void;
}

export type OpenDaemon = (token: string, handlers: StreamHandlers) => Promise<DaemonStream>;

interface StreamConnectionOptions {
	open: OpenDaemon;
	onLog?: (text: string) => void;
	onStatus?: (status: ConnectionStatus) => void;
}

type Pending = {
	resolve: (value: Reply) => void;
	reject: (error: Error) => void;
	onEvent?: (json: Json, payload: Uint8Array) => void;
	sent: boolean;
};

class Session {
	readonly id: number;
	readonly token: string;
	stream: DaemonStream | undefined;
	readonly pending = new Map<number, Pending>();
	#bytes = new Uint8Array(0);
	#start = 0;
	#end = 0;
	synced = false;
	lastSeen = Date.now();
	timer: ReturnType<typeof setInterval> | undefined;
	live = true;
	linkUp = true;

	constructor(id: number, token: string) {
		this.id = id;
		this.token = token;
	}

	get buffer(): Uint8Array {
		return this.#bytes.subarray(this.#start, this.#end);
	}

	consume(count: number): void {
		this.#start += count;
	}

	append(chunk: Uint8Array): void {
		const length = this.#end - this.#start;
		if (this.#end + chunk.length > this.#bytes.length) {
			const next = (length + chunk.length) * 2 <= this.#bytes.length ? this.#bytes : new Uint8Array((length + chunk.length) * 2);
			next.set(this.#bytes.subarray(this.#start, this.#end));
			this.#bytes = next;
			this.#start = 0;
			this.#end = length;
		}
		this.#bytes.set(chunk, this.#end);
		this.#end += chunk.length;
	}
}

export class StreamConnection {
	readonly #options: StreamConnectionOptions;
	#session: Session | undefined;
	#ready: Promise<{ info: RemoteInfo; session: Session }> | undefined;
	#sessions = 0;
	#nextId = 1;
	#closed = false;
	#status: ConnectionStatus = { kind: "idle" };

	constructor(options: StreamConnectionOptions) {
		this.#options = options;
	}

	get status(): ConnectionStatus {
		return this.#status;
	}

	#setStatus(status: ConnectionStatus): void {
		this.#status = status;
		this.#options.onStatus?.(status);
	}

	async info(): Promise<RemoteInfo> {
		return (await this.#connect()).info;
	}

	async session(): Promise<number> {
		return (await this.#connect()).session.id;
	}

	async request(op: string, json: Json, options: RequestOptions = {}): Promise<Reply> {
		if (options.session !== undefined) {
			const current = this.#session;
			if (current === undefined || current.id !== options.session || !current.live) throw unsent();
			return this.#send(current, op, json, options);
		}
		const { session } = await this.#connect();
		return this.#send(session, op, json, options);
	}

	close(): void {
		this.#closed = true;
		if (this.#session) this.#teardown(this.#session, closed());
		this.#setStatus({ kind: "closed" });
	}

	kill(id: number, session: number): void {
		const current = this.#session;
		if (current?.id === session && current.live) this.#write(current, frame(CANCEL, id, { mode: "kill" }));
	}

	#connect(): Promise<{ info: RemoteInfo; session: Session }> {
		if (this.#closed) return Promise.reject(closed());
		if (this.#ready === undefined) {
			const ready = this.#start();
			this.#ready = ready;
			onFailure(ready, () => {
				if (this.#ready === ready) this.#ready = undefined;
			});
		}
		return this.#ready;
	}

	#send(session: Session, op: string, json: Json, options: RequestOptions): Promise<Reply> {
		if (!session.live) return Promise.reject(unsent());
		const id = this.#nextId++;
		return new Promise((resolve, reject) => {
			const onAbort = () => this.#write(session, frame(CANCEL, id, {}));
			const done = () => options.signal?.removeEventListener("abort", onAbort);
			const pending: Pending = {
				resolve: (value) => {
					done();
					resolve(value);
				},
				reject: (error) => {
					done();
					reject(error);
				},
				...(options.onEvent ? { onEvent: options.onEvent } : {}),
				sent: false,
			};
			session.pending.set(id, pending);
			options.signal?.addEventListener("abort", onAbort, { once: true });
			options.onStart?.(id, session.id);
			pending.sent = this.#write(session, frame(REQUEST, id, { ...json, op }, options.payload));
			if (!pending.sent) {
				session.pending.delete(id);
				pending.reject(unsent());
				return;
			}
			if (options.signal?.aborted) onAbort();
		});
	}

	#write(session: Session, data: Uint8Array<ArrayBuffer>): boolean {
		if (!session.live || !session.stream) return false;
		session.stream.send(data);
		return true;
	}

	async #start(): Promise<{ info: RemoteInfo; session: Session }> {
		if (this.#closed) throw closed();
		const token = randomHex(16);
		const session = new Session(++this.#sessions, token);
		this.#session = session;
		this.#setStatus({ kind: "connecting" });

		let startTimer: ReturnType<typeof setTimeout> | undefined;
		let rejectStart: (error: Error) => void = () => {};
		const failed = new Promise<never>((_resolve, reject) => {
			rejectStart = reject;
			startTimer = setTimeout(() => reject(lost(`Sandbox did not answer within ${START_TIMEOUT_MS / 1000} s`)), START_TIMEOUT_MS);
		});
		void settled(failed);
		try {
			session.stream = await this.#options.open(token, {
				onData: (data) => this.#onData(session, data),
				onClose: (reason) => {
					const error = lost(reason ? `pi-env connection lost: ${reason}` : "pi-env connection lost");
					rejectStart(lost(`Sandbox connection closed before it was ready${reason ? `: ${reason}` : ""}`));
					this.#teardown(session, error);
				},
				onLink: (up) => {
					if (!session.live) return;
					session.linkUp = up;
					session.lastSeen = Date.now();
					this.#setStatus(up ? { kind: "connected", session: session.id } : { kind: "reattaching", session: session.id, since: Date.now() });
				},
			});
		} catch (error) {
			clearTimeout(startTimer);
			const reason = error instanceof Error ? error : lost(String(error));
			this.#teardown(session, reason);
			throw reason;
		}
		if (!session.live) {
			clearTimeout(startTimer);
			session.stream.close();
			throw lost("Sandbox connection closed before it was ready");
		}

		session.timer = setInterval(() => {
			if (!session.linkUp) return;
			this.#write(session, frame(PING, 0, {}));
			if (Date.now() - session.lastSeen <= SILENCE_LIMIT_MS) return;
			if (session.stream?.retry) {
				session.lastSeen = Date.now();
				session.stream.retry();
				return;
			}
			this.#teardown(session, lost("pi-env connection timed out"));
		}, PING_INTERVAL_MS);

		try {
			const { json } = await Promise.race([this.#send(session, "hello", { protocol: 1 }, {}), failed]);
			const hello = check(Hello, json, "pi-env hello");
			if (!hello.ok) throw lost(hello.problem);
			const info: RemoteInfo = hello.value;
			this.#setStatus({ kind: "connected", session: session.id });
			return { info, session };
		} catch (error) {
			this.#teardown(session, error instanceof Error ? error : lost(String(error)));
			throw error;
		} finally {
			clearTimeout(startTimer);
		}
	}

	#teardown(session: Session, error: Error): void {
		if (!session.live) return;
		session.live = false;
		clearInterval(session.timer);
		if (this.#session === session) {
			this.#session = undefined;
			this.#ready = undefined;
		}
		session.stream?.close();
		const pending = [...session.pending.values()];
		session.pending.clear();
		for (const request of pending) request.reject(request.sent && error instanceof RemoteError ? unknownOutcome(error) : request.sent ? error : unsent());
		if (!this.#closed) this.#setStatus({ kind: "lost", reason: error.message, at: Date.now() });
	}

	#onData(session: Session, chunk: Uint8Array): void {
		if (!session.live) return;
		session.lastSeen = Date.now();
		session.append(chunk);
		if (!session.synced) {
			const marker = encoder.encode(`PI-ENV ${session.token}\n`);
			const index = indexOf(session.buffer, marker);
			if (index === -1) {
				if (session.buffer.length > 1024 * 1024) session.consume(session.buffer.length - marker.length);
				return;
			}
			const noise = decoder.decode(session.buffer.subarray(0, index)).trim();
			if (noise) this.#options.onLog?.(noise);
			session.consume(index + marker.length);
			session.synced = true;
		}
		let offset = 0;
		const buffer = session.buffer;
		const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
		while (session.live && buffer.length - offset >= 4) {
			const length = view.getUint32(offset);
			if (length < 9 || length > MAX_FRAME + 64) {
				this.#teardown(session, lost("Corrupt frame from pi-env"));
				return;
			}
			if (buffer.length - offset < 4 + length) break;
			const type = view.getUint8(offset + 4);
			const id = view.getUint32(offset + 5);
			const jsonLength = view.getUint32(offset + 9);
			const json = 9 + jsonLength > length ? undefined : decode(FrameJson, decoder.decode(buffer.subarray(offset + 13, offset + 13 + jsonLength)));
			if (!json) {
				this.#teardown(session, lost("Corrupt frame from pi-env"));
				return;
			}
			const payload = buffer.slice(offset + 13 + jsonLength, offset + 4 + length);
			offset += 4 + length;
			this.#dispatch(session, type, id, json, payload);
		}
		session.consume(offset);
	}

	#dispatch(session: Session, type: number, id: number, json: Json, payload: Uint8Array): void {
		const pending = session.pending.get(id);
		if (type === EVENT) {
			pending?.onEvent?.(json, payload);
			return;
		}
		if (type !== RESULT && type !== ERROR) return;
		if (pending === undefined) return;
		session.pending.delete(id);
		if (type === RESULT) pending.resolve({ json, payload, session: session.id });
		else pending.reject(new RemoteError(json));
	}
}
