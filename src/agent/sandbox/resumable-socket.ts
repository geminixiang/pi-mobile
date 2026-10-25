import { Type } from "typebox";
import { log } from "../../log.ts";
import { decode } from "../parse.ts";

export type RawMessage = ArrayBuffer | string;
export type RawSocket = { send(data: Uint8Array<ArrayBuffer> | string): void; close(): void };
export type OpenRaw = (url: URL, onMessage: (data: RawMessage) => void, onClose: (reason: string | undefined) => void) => Promise<RawSocket>;

export interface ResumableOptions {
	first: URL;
	attach: (received: number) => URL;
	open: OpenRaw;
	what: string;
	onMessage: (data: RawMessage) => void;
	onClose: (reason: string | undefined) => void;
	onLink?: (up: boolean) => void;
}

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];
const RESUME_LIMIT_MS = 270_000;
const SENT_LOG_BYTES = 4 * 1024 * 1024;
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
	#down = false;
	#downSince = 0;
	#attempt = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;

	private constructor(options: ResumableOptions) {
		this.#options = options;
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
		if (this.#socket && !this.#down) this.#socket.send(data);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		clearTimeout(this.#timer);
		this.#socket?.close();
		this.#socket = undefined;
	}

	retry(): void {
		if (this.#closed || this.#down) return;
		const socket = this.#socket;
		this.#socket = undefined;
		socket?.close();
		this.#dropped();
	}

	#open(url: URL, attaching: boolean): Promise<RawSocket> {
		let awaitingResume = attaching;
		let self: RawSocket | undefined;
		const opened = this.#options.open(
			url,
			(data) => {
				if (this.#closed || (self && self !== this.#socket)) return;
				if (awaitingResume) {
					awaitingResume = false;
					const resume = typeof data === "string" ? decode(Resume, data) : undefined;
					if (!resume) return this.#final(`${this.#options.what} answered the resume with something else`);
					return this.#resume(resume.received);
				}
				this.#received++;
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
		this.#closed = true;
		clearTimeout(this.#timer);
		this.#socket?.close();
		this.#socket = undefined;
		this.#options.onClose(reason);
	}

	#dropped(): void {
		if (this.#closed) return;
		if (!this.#down) {
			this.#down = true;
			this.#downSince = Date.now();
			this.#attempt = 0;
			log.info("host.resume", { what: this.#options.what, state: "dropped", received: this.#received, sent: this.#sentBase + this.#sent.length });
			this.#options.onLink?.(false);
		}
		const delay = RETRY_DELAYS_MS[Math.min(this.#attempt, RETRY_DELAYS_MS.length - 1)] ?? 15000;
		this.#timer = setTimeout(() => void this.#attach(), delay);
	}

	async #attach(): Promise<void> {
		if (this.#closed) return;
		if (Date.now() - this.#downSince > RESUME_LIMIT_MS) {
			log.warn("host.resume", { what: this.#options.what, state: "gave_up", attempts: this.#attempt });
			return this.#final(`could not reach ${this.#options.what} again within ${Math.round(RESUME_LIMIT_MS / 60_000)} minutes`);
		}
		this.#attempt++;
		try {
			const socket = await this.#open(this.#options.attach(this.#received), true);
			if (this.#closed) return socket.close();
			this.#socket = socket;
		} catch {
			this.#dropped();
		}
	}

	#resume(received: number): void {
		const socket = this.#socket;
		if (!socket) return;
		if (received < this.#sentBase) return this.#final(`${this.#options.what} is missing more than this phone kept; the command may still be running there`);
		const missing = this.#sent.slice(received - this.#sentBase);
		for (const data of missing) socket.send(data);
		this.#down = false;
		log.info("host.resume", { what: this.#options.what, state: "attached", attempts: this.#attempt, resent: missing.length, received: this.#received });
		this.#options.onLink?.(true);
	}
}
