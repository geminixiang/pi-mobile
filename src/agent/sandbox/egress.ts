// Control channel to the sandbox relay for credentials used inside sandboxes (see sandbox/egress).
//
// While the app runs it keeps a WebSocket open to the relay's /control endpoint. It sends the GitHub token (held in
// the relay's memory only, never inside a sandbox), mints short-lived access tokens for services whose long-lived
// credential stays on the phone (Google Cloud, Cloudflare) when the relay asks, and answers the egress proxy's write
// approvals with the app's confirmation dialog. It reconnects with backoff, so approvals asked while the phone was
// away arrive again.
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { requestConfirmation } from "../confirm.ts";
import type { AccessToken } from "../oauth.ts";

const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

/** What the relay sends on the control channel. */
const RelayMessage = Type.Union([
	Type.Object({ type: Type.Literal("approve"), id: Type.Number(), sandbox: Type.String(), title: Type.String(), detail: Type.String() }),
	Type.Object({ type: Type.Literal("token"), service: Type.String(), scope: Type.Optional(Type.String()) }),
]);
type Approval = Extract<Static<typeof RelayMessage>, { type: "approve" }>;

/** A service whose access tokens the phone mints on request. */
export interface MintedService {
	/** `scope` names the resource for services with one token per resource (Azure); others ignore it. */
	get(scope?: string): Promise<AccessToken>;
	/** Sandbox environment for this service, such as the default project or account. */
	env: Record<string, string>;
}

export interface EgressLinkOptions {
	relayUrl: string;
	relayToken: string;
	githubToken: string | undefined;
	/** By relay service name: "gcloud", "cloudflare", "azure". */
	minted: Record<string, MintedService>;
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
			const minted = Object.fromEntries(Object.entries(this.#options.minted).map(([name, service]) => [name, { env: service.env }]));
			socket.send(JSON.stringify({ type: "hello", githubToken: this.#options.githubToken ?? null, minted }));
		});
		socket.addEventListener("message", (event) => {
			if (typeof event.data !== "string") return;
			let message: unknown;
			try {
				message = JSON.parse(event.data);
			} catch {
				return;
			}
			// Unknown messages come from a newer relay; ignore them.
			if (!Value.Check(RelayMessage, message)) return;
			switch (message.type) {
				case "approve":
					void this.#approve(message);
					break;
				case "token":
					void this.#token(socket, message.service, message.scope ?? "");
					break;
				default: {
					const _exhaustive: never = message;
					return _exhaustive;
				}
			}
		});
		socket.addEventListener("close", () => {
			if (this.#socket !== socket || this.#closed) return;
			this.#timer = setTimeout(() => this.#connect(), this.#retry);
			this.#retry = Math.min(this.#retry * 2, MAX_RETRY_MS);
		});
	}

	async #token(socket: WebSocket, service: string, scope: string): Promise<void> {
		try {
			const source = this.#options.minted[service];
			if (!source) throw new Error(`沒有 ${service} 憑證`);
			const token = await source.get(scope || undefined);
			socket.send(JSON.stringify({ type: "token", service, scope, token: token.token, expiresAt: token.expiresAt }));
		} catch (error) {
			socket.send(JSON.stringify({ type: "token", service, scope, error: error instanceof Error ? error.message : String(error) }));
		}
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
