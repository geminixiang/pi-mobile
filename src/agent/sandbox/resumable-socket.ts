import { Type } from "typebox";
import { log } from "../../log.ts";
import { decode } from "../../parse.ts";
import type { Network } from "../network.ts";

export type RawMessage = ArrayBuffer | string;
export type RawSocket = { send(data: Uint8Array<ArrayBuffer> | string): void; close(code?: number): void };
export type Link = "up" | "reattaching" | "offline";
export type OpenRaw = (url: URL, what: string, onMessage: (data: RawMessage) => void, onClose: (reason: string | undefined) => void) => Promise<RawSocket>;

export interface ResumableOptions {
	first: URL;
	attach: (received: number) => URL;
	open: OpenRaw;
	what: string;
	onMessage: (data: RawMessage) => void;
	onClose: (reason: string | undefined) => void;
	onLink?: (link: Link) => void;
	network: Network;
	quietLimitMs: number;
	resumeLimitMs: number;
}

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];
export const RESUME_LIMIT_MS = 270_000;
const SENT_LOG_BYTES = 4 * 1024 * 1024;
// why: the computer ends a held session only on a normal closure (1000); a closure without a code, like the reattach after a quiet link, keeps it held.
const NORMAL_CLOSURE = 1000;
const Resume = Type.Object({ received: Type.Integer({ minimum: 0 }) });

function size(data: Uint8Array | string): number {
	return typeof data === "string" ? data.length : data.byteLength;
}

type State =
	| { kind: "up"; socket: RawSocket }
	| { kind: "attaching"; attempt: number; socket: RawSocket | undefined }
	| { kind: "waiting"; attempt: number; timer: ReturnType<typeof setTimeout> }
	| { kind: "offline"; attempt: number }
	| { kind: "closed" };

const LINK: Record<Exclude<State["kind"], "closed">, Link> = { up: "up", attaching: "reattaching", waiting: "reattaching", offline: "offline" };

const socketOf = (state: State): RawSocket | undefined => (state.kind === "up" || state.kind === "attaching" ? state.socket : undefined);

export class ResumableSocket {
	readonly #options: ResumableOptions;
	#state: State;
	#received = 0;
	#sent: (Uint8Array<ArrayBuffer> | string)[] = [];
	#sentBase = 0;
	#sentBytes = 0;
	#unreachableMs = 0;
	#onlineSince: number | undefined;
	#lastMessage = Date.now();
	readonly #quiet: ReturnType<typeof setInterval>;
	readonly #unwatch: () => void;

	private constructor(options: ResumableOptions) {
		this.#options = options;
		this.#state = { kind: "attaching", attempt: 0, socket: undefined };
		this.#quiet = setInterval(() => this.#checkQuiet(), options.quietLimitMs / 4);
		this.#unwatch = options.network.onChange(() => this.#networkChanged());
	}

	static async connect(options: ResumableOptions): Promise<ResumableSocket> {
		const resumable = new ResumableSocket(options);
		try {
			resumable.#state = { kind: "up", socket: await resumable.#open(options.first, false) };
		} catch (error) {
			resumable.close();
			throw error;
		}
		return resumable;
	}

	send(data: Uint8Array<ArrayBuffer> | string): void {
		if (this.#state.kind === "closed") return;
		this.#sent.push(data);
		this.#sentBytes += size(data);
		while (this.#sentBytes > SENT_LOG_BYTES && this.#sent.length > 1) {
			this.#sentBytes -= size(this.#sent[0] ?? "");
			this.#sent.shift();
			this.#sentBase++;
		}
		if (this.#state.kind === "up") this.#state.socket.send(data);
	}

	close(): void {
		const state = this.#state;
		if (state.kind === "closed") return;
		if (state.kind === "waiting") clearTimeout(state.timer);
		this.#state = { kind: "closed" };
		clearInterval(this.#quiet);
		this.#unwatch();
		socketOf(state)?.close(NORMAL_CLOSURE);
	}

	#open(url: URL, attaching: boolean): Promise<RawSocket> {
		let awaitingResume = attaching;
		let self: RawSocket | undefined;
		const live = () => this.#state.kind !== "closed" && (self === undefined || socketOf(this.#state) === self);
		const opened = this.#options.open(
			url,
			this.#options.what,
			(data) => {
				if (!live()) return;
				if (awaitingResume) {
					awaitingResume = false;
					const resume = typeof data === "string" ? decode(Resume, data) : undefined;
					if (!resume) return this.#final(`${this.#options.what} answered the resume with something else`);
					return this.#resume(resume.received);
				}
				this.#received++;
				this.#lastMessage = Date.now();
				this.#options.onMessage(data);
			},
			(reason) => {
				if (!live()) return;
				if (reason) return this.#final(reason);
				this.#dropped();
			},
		);
		return opened.then((socket) => {
			self = socket;
			return socket;
		});
	}

	#is(state: State): boolean {
		return this.#state === state;
	}

	#enter(state: State): void {
		const before = this.#state.kind === "closed" ? undefined : LINK[this.#state.kind];
		this.#state = state;
		if (state.kind === "closed") return;
		const link = LINK[state.kind];
		if (link !== before) this.#options.onLink?.(link);
	}

	#checkQuiet(): void {
		const socket = socketOf(this.#state);
		if (!socket || Date.now() - this.#lastMessage <= this.#options.quietLimitMs) return;
		socket.close();
		this.#dropped();
	}

	#final(reason: string): void {
		if (this.#state.kind === "closed") return;
		this.close();
		this.#options.onClose(reason);
	}

	#dropped(): void {
		const state = this.#state;
		if (state.kind === "closed") return;
		if (state.kind === "up") {
			this.#unreachableMs = 0;
			this.#onlineSince = undefined;
			log.info("host.resume", { what: this.#options.what, state: "dropped", received: this.#received, sent: this.#sentBase + this.#sent.length });
		}
		if (state.kind === "waiting") clearTimeout(state.timer);
		const attempt = state.kind === "up" ? 0 : state.attempt;
		if (this.#onlineFor() === undefined) return this.#enter({ kind: "offline", attempt });
		const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? 15000;
		this.#enter({ kind: "waiting", attempt, timer: setTimeout(() => void this.#attach(attempt), delay) });
	}

	#networkChanged(): void {
		const state = this.#state;
		if (state.kind !== "waiting" && state.kind !== "offline") return;
		if (state.kind === "waiting") clearTimeout(state.timer);
		void this.#attach(0);
	}

	#onlineFor(): number | undefined {
		const now = Date.now();
		if (!this.#options.network.online()) {
			if (this.#onlineSince !== undefined) this.#unreachableMs += now - this.#onlineSince;
			this.#onlineSince = undefined;
			return undefined;
		}
		this.#onlineSince ??= now;
		return this.#unreachableMs + now - this.#onlineSince;
	}

	async #attach(attempt: number): Promise<void> {
		if (this.#state.kind !== "waiting" && this.#state.kind !== "offline") return;
		const unreachable = this.#onlineFor();
		if (unreachable === undefined) return this.#enter({ kind: "offline", attempt });
		const limit = this.#options.resumeLimitMs;
		if (unreachable > limit) {
			log.warn("host.resume", { what: this.#options.what, state: "gave_up", attempts: attempt });
			return this.#final(`could not reach ${this.#options.what} for ${limit / 60_000} minutes while this phone was online`);
		}
		const attaching: Extract<State, { kind: "attaching" }> = { kind: "attaching", attempt: attempt + 1, socket: undefined };
		this.#enter(attaching);
		const stillAttaching = () => this.#is(attaching);
		try {
			const socket = await this.#open(this.#options.attach(this.#received), true);
			if (!stillAttaching()) return socket.close(NORMAL_CLOSURE);
			attaching.socket = socket;
			this.#lastMessage = Date.now();
		} catch {
			if (stillAttaching()) this.#dropped();
		}
	}

	#resume(received: number): void {
		const state = this.#state;
		if (state.kind !== "attaching" || !state.socket) return;
		if (received < this.#sentBase) return this.#final(`${this.#options.what} is missing more than this phone kept; the command may still be running there`);
		const missing = this.#sent.slice(received - this.#sentBase);
		for (const data of missing) state.socket.send(data);
		this.#lastMessage = Date.now();
		log.info("host.resume", { what: this.#options.what, state: "attached", attempts: state.attempt, resent: missing.length, received: this.#received });
		this.#enter({ kind: "up", socket: state.socket });
	}
}

