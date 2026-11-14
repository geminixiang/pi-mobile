import { log } from "../../log.ts";
import type { Network } from "../network.ts";
import { bytesOf, type Traffic } from "../traffic.ts";
import { type Effect, type Link, type LinkEvent, type LinkState, linkOf, type RawMessage, step } from "./resumable-link.ts";

export type RawSocket = { send(data: Uint8Array<ArrayBuffer> | string): void; close(code?: number): void };
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
	traffic: Traffic;
	quietLimitMs: number;
	resumeLimitMs: number;
}

export const RESUME_LIMIT_MS = 270_000;
const SENT_LOG_BYTES = 4 * 1024 * 1024;

type Data = Uint8Array<ArrayBuffer> | string;

function size(data: Data): number {
	return typeof data === "string" ? data.length : data.byteLength;
}

class Outbox {
	#messages: Data[] = [];
	#base = 0;
	#bytes = 0;

	get base(): number {
		return this.#base;
	}

	get end(): number {
		return this.#base + this.#messages.length;
	}

	push(data: Data): void {
		this.#messages.push(data);
		this.#bytes += size(data);
		while (this.#bytes > SENT_LOG_BYTES && this.#messages.length > 1) {
			this.#bytes -= size(this.#messages[0] ?? "");
			this.#messages.shift();
			this.#base++;
		}
	}

	since(have: number): Data[] {
		return this.#messages.slice(have - this.#base);
	}
}

export class ResumableSocket {
	readonly #options: ResumableOptions;
	#state: LinkState<RawSocket>;
	#retry: ReturnType<typeof setTimeout> | undefined;
	#received = 0;
	readonly #sent = new Outbox();
	readonly #quiet: ReturnType<typeof setInterval>;
	readonly #unwatch: () => void;

	private constructor(options: ResumableOptions) {
		this.#options = options;
		this.#state = { kind: "opening", heardAt: Date.now() };
		this.#quiet = setInterval(() => this.#dispatch({ kind: "quiet" }), options.quietLimitMs / 4);
		this.#unwatch = options.network.onChange(() => this.#dispatch({ kind: "network" }));
	}

	static async connect(options: ResumableOptions): Promise<ResumableSocket> {
		const resumable = new ResumableSocket(options);
		try {
			resumable.#dispatch({ kind: "opened", socket: await resumable.#open(options.first) });
		} catch (error) {
			resumable.close();
			throw error;
		}
		return resumable;
	}

	send(data: Data): void {
		if (this.#state.kind === "closed") return;
		this.#sent.push(data);
		if (this.#state.kind === "up") this.#state.socket.send(data);
	}

	close(): void {
		this.#dispatch({ kind: "close" });
	}

	#dispatch(event: LinkEvent<RawSocket>): void {
		const before = this.#state;
		const { what, quietLimitMs, resumeLimitMs } = this.#options;
		const { state, effects } = step(before, event, { now: Date.now(), online: this.#options.network.online(), kept: this.#sent.base }, { what, quietLimitMs, resumeLimitMs });
		this.#state = state;
		if (state !== before) this.#entered(before, state);
		for (const effect of effects) this.#run(effect);
	}

	#entered(before: LinkState<RawSocket>, state: LinkState<RawSocket>): void {
		clearTimeout(this.#retry);
		if (state.kind === "waiting") this.#retry = setTimeout(() => this.#dispatch({ kind: "retry" }), state.delay);
		if (state.kind === "closed") {
			clearInterval(this.#quiet);
			this.#unwatch();
			return;
		}
		const was = linkOf(before);
		const link = linkOf(state);
		if (was !== undefined && link !== undefined && link !== was) this.#options.onLink?.(link);
	}

	#run(effect: Effect<RawSocket>): void {
		const { what } = this.#options;
		switch (effect.kind) {
			case "deliver":
				this.#received++;
				return this.#options.onMessage(effect.data);
			case "resend": {
				const missing = this.#sent.since(effect.from);
				for (const data of missing) effect.socket.send(data);
				return log.info("host.resume", { what, state: "attached", attempts: effect.attempts, resent: missing.length, received: this.#received });
			}
			case "close":
				return effect.socket.close(effect.code);
			case "dial":
				return void this.#open(this.#options.attach(this.#received)).then(
					(socket) => this.#dispatch({ kind: "dialed", from: effect.from, socket }),
					() => this.#dispatch({ kind: "unreachable", from: effect.from }),
				);
			case "dropped":
				return log.info("host.resume", { what, state: "dropped", received: this.#received, sent: this.#sent.end });
			case "gave_up":
				return log.warn("host.resume", { what, state: "gave_up", attempts: effect.attempts });
			case "final":
				return this.#options.onClose(effect.reason);
		}
	}

	async #open(url: URL): Promise<RawSocket> {
		const { traffic } = this.#options;
		let self: RawSocket | undefined;
		const socket = await this.#options.open(
			url,
			this.#options.what,
			(data) => {
				traffic.count("down", bytesOf(data));
				if (self) this.#dispatch({ kind: "message", socket: self, data });
			},
			(reason) => {
				if (self) this.#dispatch({ kind: "ended", socket: self, reason });
			},
		);
		const counted: RawSocket = {
			send: (data) => {
				traffic.count("up", bytesOf(data));
				socket.send(data);
			},
			close: (code) => socket.close(code),
		};
		self = counted;
		return counted;
	}
}
