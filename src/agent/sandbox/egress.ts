// Control channel to the sandbox relay for GitHub access from sandboxes (see sandbox/egress).
//
// While the app runs it keeps a WebSocket open to the relay's /control endpoint, sends the user's GitHub token
// (held in the relay's memory only, never inside a sandbox), and answers the egress proxy's write approvals with the
// app's confirmation dialog. It reconnects with backoff, so approvals asked while the phone was away arrive again.
import { requestConfirmation } from "../confirm.ts";

const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

interface Approval {
	type: "approve";
	id: number;
	sandbox: string;
	title: string;
	detail: string;
}

export interface EgressLinkOptions {
	relayUrl: string;
	relayToken: string;
	githubToken: string | undefined;
	/** Human name for a sandbox, such as its conversation's title. */
	describe: (sandbox: string) => string | undefined;
}

export class EgressLink {
	readonly #options: EgressLinkOptions;
	#socket: WebSocket | undefined;
	#retry = MIN_RETRY_MS;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#closed = false;
	/** Approvals on screen, so a resend after a reconnect does not open a second dialog. */
	readonly #showing = new Set<number>();

	constructor(options: EgressLinkOptions) {
		this.#options = options;
		this.#connect();
	}

	close(): void {
		this.#closed = true;
		clearTimeout(this.#timer);
		this.#socket?.close();
	}

	#connect(): void {
		if (this.#closed) return;
		const url = new URL("/control", this.#options.relayUrl);
		url.searchParams.set("token", this.#options.relayToken);
		const socket = new WebSocket(url);
		this.#socket = socket;
		socket.addEventListener("open", () => {
			this.#retry = MIN_RETRY_MS;
			socket.send(JSON.stringify({ type: "hello", githubToken: this.#options.githubToken ?? null }));
		});
		socket.addEventListener("message", (event) => {
			if (typeof event.data !== "string") return;
			const message = JSON.parse(event.data) as Approval | { type: string };
			if (message.type === "approve") void this.#approve(message as Approval);
		});
		socket.addEventListener("close", () => {
			if (this.#socket !== socket || this.#closed) return;
			this.#timer = setTimeout(() => this.#connect(), this.#retry);
			this.#retry = Math.min(this.#retry * 2, MAX_RETRY_MS);
		});
	}

	async #approve(approval: Approval): Promise<void> {
		if (this.#showing.has(approval.id)) return;
		this.#showing.add(approval.id);
		try {
			const source = this.#options.describe(approval.sandbox) ?? approval.sandbox;
			const approved = await requestConfirmation({
				title: approval.title,
				detail: [`來自 sandbox：${source}`, approval.detail].filter(Boolean).join("\n\n"),
			});
			this.#socket?.send(JSON.stringify({ type: "approval", id: approval.id, approved }));
		} finally {
			this.#showing.delete(approval.id);
		}
	}
}
