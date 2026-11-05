import { Type } from "typebox";
import { log } from "../../log.ts";
import { decode } from "../../parse.ts";
import type { Network } from "../network.ts";

export type RawMessage = ArrayBuffer | string;
export type RawSocket = { send(data: Uint8Array<ArrayBuffer> | string): void; close(code?: number): void };
export type Link = "up" | "reattaching" | "offline";
type OpenRaw = (url: URL, what: string, onMessage: (data: RawMessage) => void, onClose: (reason: string | undefined) => void) => Promise<RawSocket>;

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

export class ResumableSocket {
	readonly #options: ResumableOptions;
	#socket: RawSocket | undefined;
	#received = 0;
	#sent: (Uint8Array<ArrayBuffer> | string)[] = [];
	#sentBase = 0;
	#sentBytes = 0;
	#closed = false;
	#link: Link = "up";
	#attaching = false;
	#unreachableMs = 0;
	#onlineSince: number | undefined;
	#attempt = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#lastMessage = Date.now();
	readonly #quiet: ReturnType<typeof setInterval>;
	readonly #unwatch: () => void;

	private constructor(options: ResumableOptions) {
		this.#options = options;
		this.#quiet = setInterval(() => this.#checkQuiet(), options.quietLimitMs / 4);
		this.#unwatch = options.network.onChange(() => this.#networkChanged());
	}

	static async connect(options: ResumableOptions): Promise<ResumableSocket> {
		const resumable = new ResumableSocket(options);
		resumable.#socket = await resumable.#open(options.first, false);
		return resumable;
	}

	send(data: Uint8Array<ArrayBuffer> | string): void {
		if (this.#closed) return;
		this.#sent.push(data);
		this.#sentBytes += size(data);
		while (this.#sentBytes > SENT_LOG_BYTES && this.#sent.length > 1) {
			this.#sentBytes -= size(this.#sent[0] ?? "");
			this.#sent.shift();
			this.#sentBase++;
		}
		if (this.#socket && this.#link === "up") this.#socket.send(data);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		clearTimeout(this.#timer);
		clearInterval(this.#quiet);
		this.#unwatch();
		this.#socket?.close(NORMAL_CLOSURE);
		this.#socket = undefined;
	}

	#checkQuiet(): void {
		if (this.#closed || !this.#socket || Date.now() - this.#lastMessage <= this.#options.quietLimitMs) return;
		const socket = this.#socket;
		this.#socket = undefined;
		socket.close();
		this.#dropped();
	}

	#open(url: URL, attaching: boolean): Promise<RawSocket> {
		let awaitingResume = attaching;
		let self: RawSocket | undefined;
		const opened = this.#options.open(
			url,
			this.#options.what,
			(data) => {
				if (this.#closed || (self && self !== this.#socket)) return;
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
				if (this.#closed || (self && self !== this.#socket)) return;
				this.#socket = undefined;
				if (reason) return this.#final(reason);
				this.#dropped();
			},
		);
		return opened.then((socket) => {
			self = socket;
			return socket;
		});
	}

	#final(reason: string): void {
		if (this.#closed) return;
		this.close();
		this.#options.onClose(reason);
	}

	#dropped(): void {
		if (this.#closed) return;
		if (this.#link === "up") {
			this.#unreachableMs = 0;
			this.#onlineSince = undefined;
			this.#attempt = 0;
			log.info("host.resume", { what: this.#options.what, state: "dropped", received: this.#received, sent: this.#sentBase + this.#sent.length });
		}
		if (this.#onlineFor() === undefined) return this.#setLink("offline");
		this.#setLink("reattaching");
		const delay = RETRY_DELAYS_MS[Math.min(this.#attempt, RETRY_DELAYS_MS.length - 1)] ?? 15000;
		this.#timer = setTimeout(() => void this.#attach(), delay);
	}

	#networkChanged(): void {
		if (this.#link === "up" || this.#attaching) return;
		clearTimeout(this.#timer);
		this.#attempt = 0;
		void this.#attach();
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

	#setLink(link: Link): void {
		if (link === this.#link) return;
		this.#link = link;
		this.#options.onLink?.(link);
	}

	async #attach(): Promise<void> {
		if (this.#closed || this.#attaching) return;
		const unreachable = this.#onlineFor();
		if (unreachable === undefined) return this.#setLink("offline");
		const limit = this.#options.resumeLimitMs;
		if (unreachable > limit) {
			log.warn("host.resume", { what: this.#options.what, state: "gave_up", attempts: this.#attempt });
			return this.#final(`could not reach ${this.#options.what} for ${limit / 60_000} minutes while this phone was online`);
		}
		this.#attempt++;
		this.#attaching = true;
		try {
			const socket = await this.#open(this.#options.attach(this.#received), true);
			if (this.#closed) return socket.close(NORMAL_CLOSURE);
			this.#socket = socket;
			this.#lastMessage = Date.now();
		} catch {
			this.#dropped();
		} finally {
			this.#attaching = false;
		}
	}

	#resume(received: number): void {
		const socket = this.#socket;
		if (!socket) return;
		if (received < this.#sentBase) return this.#final(`${this.#options.what} is missing more than this phone kept; the command may still be running there`);
		const missing = this.#sent.slice(received - this.#sentBase);
		for (const data of missing) socket.send(data);
		this.#lastMessage = Date.now();
		log.info("host.resume", { what: this.#options.what, state: "attached", attempts: this.#attempt, resent: missing.length, received: this.#received });
		this.#setLink("up");
	}
}
