// A pi-env Connection over a byte stream, for runtimes without child processes (the app WebView).
//
// Port of @earendil-works/pi-env's Connection (src/connection.ts): same frames, sync line, pings, and session
// semantics, with `spawn` replaced by a stream that some transport opens to `pi-env serve --token <hex>`: a WebSocket to
// pi-mobile serve (host.ts), directly or through a container engine's exec.
// RemoteExecutionEnv only calls info(), session(), request(), kill(), and close(), which this class provides.
import { RemoteError, type RemoteInfo, type Reply, type RequestOptions } from "@earendil-works/pi-env";

type Json = Record<string, unknown>;

const REQUEST = 1;
const RESULT = 2;
const ERROR = 3;
const EVENT = 4;
const CANCEL = 5;
const PING = 6;

const MAX_FRAME = 16 * 1024 * 1024;
const PING_INTERVAL_MS = 5000;
const SILENCE_LIMIT_MS = 30_000;
/** Includes creating a container or uploading the daemon on first use. */
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

function closed(): RemoteError {
	return new RemoteError({ code: "unknown", message: "Connection closed" });
}

function randomHex(bytes: number): string {
	return [...crypto.getRandomValues(new Uint8Array(bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
	outer: for (let i = 0; i < haystack.length - needle.length + 1; i++) {
		for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
		return i;
	}
	return -1;
}

/** A duplex byte stream to one `pi-env serve` process. */
export interface DaemonStream {
	send(data: Uint8Array<ArrayBuffer>): void;
	close(): void;
}

export interface StreamHandlers {
	onData(data: Uint8Array): void;
	/** The stream ended; `reason` says why when the transport knows. */
	onClose(reason?: string): void;
}

/**
 * Starts `pi-env serve --token <token>` and resolves once its stream is open; rejects when it cannot be reached. The
 * handlers may be called before the promise resolves (the daemon's first bytes can arrive with the open).
 */
export type OpenDaemon = (token: string, handlers: StreamHandlers) => Promise<DaemonStream>;

export interface StreamConnectionOptions {
	open: OpenDaemon;
	onLog?: (text: string) => void;
}

type Pending = {
	resolve: (value: Reply) => void;
	reject: (error: Error) => void;
	onEvent?: (json: Json, payload: Uint8Array) => void;
};

class Session {
	readonly id: number;
	readonly token: string;
	stream: DaemonStream | undefined;
	readonly pending = new Map<number, Pending>();
	buffer = new Uint8Array(0);
	synced = false;
	lastSeen = Date.now();
	timer: ReturnType<typeof setInterval> | undefined;
	live = true;

	constructor(id: number, token: string) {
		this.id = id;
		this.token = token;
	}

	append(chunk: Uint8Array): void {
		const next = new Uint8Array(this.buffer.length + chunk.length);
		next.set(this.buffer);
		next.set(chunk, this.buffer.length);
		this.buffer = next;
	}
}

export class StreamConnection {
	readonly #options: StreamConnectionOptions;
	#session: Session | undefined;
	#ready: Promise<{ info: RemoteInfo; session: Session }> | undefined;
	#sessions = 0;
	#nextId = 1;
	#closed = false;

	constructor(options: StreamConnectionOptions) {
		this.#options = options;
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
			if (current === undefined || current.id !== options.session || !current.live) throw lost("pi-env connection lost");
			return this.#send(current, op, json, options);
		}
		const { session } = await this.#connect();
		return this.#send(session, op, json, options);
	}

	close(): void {
		this.#closed = true;
		if (this.#session) this.#teardown(this.#session, closed());
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
			ready.catch(() => {
				if (this.#ready === ready) this.#ready = undefined;
			});
		}
		return this.#ready;
	}

	#send(session: Session, op: string, json: Json, options: RequestOptions): Promise<Reply> {
		if (!session.live) return Promise.reject(lost("pi-env connection lost"));
		const id = this.#nextId++;
		return new Promise((resolve, reject) => {
			const onAbort = () => this.#write(session, frame(CANCEL, id, {}));
			const done = () => options.signal?.removeEventListener("abort", onAbort);
			session.pending.set(id, {
				resolve: (value) => {
					done();
					resolve(value);
				},
				reject: (error) => {
					done();
					reject(error);
				},
				...(options.onEvent ? { onEvent: options.onEvent } : {}),
			});
			options.signal?.addEventListener("abort", onAbort, { once: true });
			options.onStart?.(id, session.id);
			this.#write(session, frame(REQUEST, id, { ...json, op }, options.payload));
			if (options.signal?.aborted) onAbort();
		});
	}

	#write(session: Session, data: Uint8Array<ArrayBuffer>): void {
		if (session.live) session.stream?.send(data);
	}

	async #start(): Promise<{ info: RemoteInfo; session: Session }> {
		if (this.#closed) throw closed();
		const token = randomHex(16);
		const session = new Session(++this.#sessions, token);
		this.#session = session;

		let startTimer: ReturnType<typeof setTimeout> | undefined;
		let rejectStart: (error: Error) => void = () => {};
		const failed = new Promise<never>((_resolve, reject) => {
			rejectStart = reject;
			startTimer = setTimeout(() => reject(lost(`Sandbox did not answer within ${START_TIMEOUT_MS / 1000} s`)), START_TIMEOUT_MS);
		});
		failed.catch(() => {});
		try {
			session.stream = await this.#options.open(token, {
				onData: (data) => this.#onData(session, data),
				onClose: (reason) => {
					const error = lost(reason ? `pi-env connection lost: ${reason}` : "pi-env connection lost");
					rejectStart(lost(`Sandbox connection closed before it was ready${reason ? `: ${reason}` : ""}`));
					this.#teardown(session, error);
				},
			});
		} catch (error) {
			clearTimeout(startTimer);
			const reason = error instanceof Error ? error : lost(String(error));
			this.#teardown(session, reason);
			throw reason;
		}
		// The stream may have closed while it opened.
		if (!session.live) {
			clearTimeout(startTimer);
			session.stream.close();
			throw lost("Sandbox connection closed before it was ready");
		}

		session.timer = setInterval(() => {
			this.#write(session, frame(PING, 0, {}));
			if (Date.now() - session.lastSeen > SILENCE_LIMIT_MS) this.#teardown(session, lost("pi-env connection timed out"));
		}, PING_INTERVAL_MS);

		try {
			const { json } = await Promise.race([this.#send(session, "hello", { protocol: 1 }, {}), failed]);
			if (json.protocol !== 1) throw lost(`Unsupported protocol ${json.protocol}`);
			return { info: json as unknown as RemoteInfo, session };
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
		for (const request of pending) request.reject(error);
	}

	#onData(session: Session, chunk: Uint8Array): void {
		if (!session.live) return;
		session.lastSeen = Date.now();
		session.append(chunk);
		if (!session.synced) {
			// The daemon's first output is `PI-ENV <token>\n`; anything before it is shell noise.
			const marker = encoder.encode(`PI-ENV ${session.token}\n`);
			const index = indexOf(session.buffer, marker);
			if (index === -1) {
				if (session.buffer.length > 1024 * 1024) session.buffer = session.buffer.slice(-marker.length);
				return;
			}
			const noise = decoder.decode(session.buffer.subarray(0, index)).trim();
			if (noise) this.#options.onLog?.(noise);
			session.buffer = session.buffer.slice(index + marker.length);
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
			let json: Json;
			try {
				if (9 + jsonLength > length) throw new Error("JSON length out of range");
				const parsed: unknown = JSON.parse(decoder.decode(buffer.subarray(offset + 13, offset + 13 + jsonLength)));
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
				json = parsed as Json;
			} catch {
				this.#teardown(session, lost("Corrupt frame from pi-env"));
				return;
			}
			const payload = buffer.slice(offset + 13 + jsonLength, offset + 4 + length);
			offset += 4 + length;
			this.#dispatch(session, type, id, json, payload);
		}
		session.buffer = buffer.slice(offset);
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
