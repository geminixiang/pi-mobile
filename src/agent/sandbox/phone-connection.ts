import { Buffer } from "buffer";
import { Type } from "typebox";
import { Connection, RemoteError, type RemoteInfo, type Reply, type RequestOptions } from "@earendil-works/pi-env";
import wire from "../../../host/protocol.json" with { type: "json" };
import { check } from "../../parse.ts";
import { messageOf } from "../../promise.ts";
import { registerProgram } from "../../shims/node-child-process.ts";
import { type Daemon, type DaemonEffect, type DaemonEvent, type DaemonStream, daemonStep, lineOf, read, type Reader } from "./daemon-state.ts";
import type { Link } from "./resumable-link.ts";

type Json = Record<string, unknown>;

export type ConnectionStatus =
	| { kind: "idle" }
	| { kind: "connecting" }
	| { kind: "connected"; session: number }
	| { kind: "reattaching"; session: number; since: number }
	| { kind: "offline"; session: number; since: number }
	| { kind: "lost"; reason: string; at: number }
	| { kind: "closed" };

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

const PING_EVERY_MS = 5000;
// why: pi-env's Connection drops a daemon after 30 s without bytes, so while the link is down and the computer holds the daemon, the phone stands in for its pings.
const DAEMON_PING = Buffer.from(wire.piEnvPing);

function ownsArrayBuffer(data: Uint8Array): data is Uint8Array<ArrayBuffer> {
	return data.buffer instanceof ArrayBuffer;
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

class DaemonProcess extends Events {
	readonly stdout = new Events();
	readonly stderr = new TextStream();
	readonly #session: number;
	readonly #marker: Buffer;
	readonly #report: (status: ConnectionStatus) => void;
	#daemon: Daemon = { kind: "opening", queued: [] };
	#reader: Reader = { kind: "greeting", pending: Buffer.alloc(0) };
	#pings: ReturnType<typeof setInterval> | undefined;
	readonly stdin = {
		write: (data: Uint8Array) => this.#dispatch({ kind: "write", data: ownsArrayBuffer(data) ? data : new Uint8Array(data) }),
		end: () => undefined,
		on: () => undefined,
	};

	constructor(token: string, session: number, open: OpenDaemon, report: (status: ConnectionStatus) => void) {
		super();
		this.#session = session;
		this.#marker = Buffer.from(`PI-ENV ${token}\n`, "utf8");
		this.#report = report;
		report({ kind: "connecting" });
		open(token, { onData: (data) => this.#onData(data), onClose: (reason) => this.end(reason ?? "the computer closed the connection"), onLink: (link) => this.#dispatch({ kind: "link", link, now: Date.now() }) }).then(
			(stream) => this.#dispatch({ kind: "opened", stream }),
			(error: unknown) => this.#dispatch({ kind: "failed", reason: messageOf(error) }),
		);
	}

	kill(): void {
		this.end("the phone closed the connection");
	}

	end(reason: string): void {
		this.#dispatch({ kind: "end", reason });
	}

	#dispatch(event: DaemonEvent): void {
		const { state, effects } = daemonStep(this.#daemon, event);
		this.#daemon = state;
		this.#pace();
		for (const effect of effects) this.#run(effect);
	}

	#pace(): void {
		if (lineOf(this.#daemon).kind === "up") {
			clearInterval(this.#pings);
			this.#pings = undefined;
			return;
		}
		this.#pings ??= setInterval(() => this.#reader.kind === "framed" && this.stdout.emit("data", DAEMON_PING), PING_EVERY_MS);
	}

	#run(effect: DaemonEffect): void {
		switch (effect.kind) {
			case "send":
				for (const data of effect.data) effect.stream.send(data);
				return;
			case "close":
				return effect.stream.close();
			case "error":
				return void this.emit("error", lost(effect.reason));
			case "lost":
				this.#reader = this.#reader.kind === "framed" ? { kind: "framed", pending: [], bytes: 0, need: 4 } : { kind: "greeting", pending: Buffer.alloc(0) };
				this.#report({ kind: "lost", reason: effect.reason, at: Date.now() });
				this.stderr.emit("data", effect.reason);
				return void this.emit("exit", null);
			case "status":
				return this.#report(this.#status());
		}
	}

	#status(): ConnectionStatus {
		const line = lineOf(this.#daemon);
		if (line.kind === "down") return { kind: line.link, session: this.#session, since: line.since };
		return this.#reader.kind === "framed" ? { kind: "connected", session: this.#session } : { kind: "connecting" };
	}

	#onData(data: Uint8Array): void {
		if (this.#daemon.kind === "ended") return;
		const { reader, frames, greeted } = read(this.#reader, data, this.#marker);
		this.#reader = reader;
		if (greeted && lineOf(this.#daemon).kind === "up") this.#report(this.#status());
		if (frames) this.stdout.emit("data", frames);
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
