// Remote sandbox: a Linux container per conversation on the user's own machine (a Raspberry Pi over Tailscale),
// reached through the relay in sandbox/relay. Durable's coding tools (read, write, edit, bash) run there.
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { type Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { WebSocketConnection } from "./ws-connection.ts";

export interface SandboxConfig {
	/** ws://host:port of the relay. */
	url: string;
	token: string;
}

const WORKSPACE = "/workspace";

export function sandboxName(conversationId: ConversationId): string {
	return `c${String(conversationId)}`;
}

/** One connection and environment per conversation, kept while the app runs. */
export class SandboxPool {
	readonly #config: SandboxConfig;
	readonly #envs = new Map<string, { env: RemoteExecutionEnv; connection: WebSocketConnection }>();

	constructor(config: SandboxConfig) {
		this.#config = config;
	}

	env(conversationId: ConversationId): ExecutionEnv {
		const name = sandboxName(conversationId);
		let entry = this.#envs.get(name);
		if (!entry) {
			const connection = new WebSocketConnection({
				relayUrl: this.#config.url,
				relayToken: this.#config.token,
				sandbox: name,
				onLog: (text) => console.warn(`[sandbox ${name}]`, text),
			});
			// RemoteExecutionEnv only uses info/session/request/kill/close, which WebSocketConnection implements.
			const env = new RemoteExecutionEnv({ connection: connection as unknown as Connection, id: `sandbox:${name}`, cwd: WORKSPACE });
			entry = { env, connection };
			this.#envs.set(name, entry);
		}
		return entry.env;
	}

	/** Whether the conversation has a container already; browsing files should not create one. */
	async exists(conversationId: ConversationId): Promise<boolean> {
		const name = sandboxName(conversationId);
		if (this.#envs.has(name)) return true;
		const url = new URL("/sandboxes", this.#config.url.replace(/^ws/, "http"));
		url.searchParams.set("token", this.#config.token);
		const response = await fetch(url);
		if (!response.ok) throw new Error(`Listing sandboxes failed: HTTP ${response.status}`);
		return ((await response.json()) as { id: string }[]).some((sandbox) => sandbox.id === name);
	}

	/** Remove the conversation's container and its files on the relay host. */
	async remove(conversationId: ConversationId): Promise<void> {
		const name = sandboxName(conversationId);
		this.#envs.get(name)?.connection.close();
		this.#envs.delete(name);
		const url = new URL(`/sandboxes/${name}`, this.#config.url.replace(/^ws/, "http"));
		url.searchParams.set("token", this.#config.token);
		const response = await fetch(url, { method: "DELETE" });
		if (!response.ok) throw new Error(`Removing the sandbox failed: HTTP ${response.status}`);
	}

	close(): void {
		for (const { connection } of this.#envs.values()) connection.close();
		this.#envs.clear();
	}
}

export const SandboxExtension = defineExtension({
	name: "sandbox",
	sections: [
		section(
			"sandbox",
			() =>
				[
					"read, write, edit, and bash run in this conversation's own Linux sandbox on the user's computer, not on the phone:",
					"a Debian 13 container (arm64) with Node 24 (npm, pnpm), Python 3.13 with uv (`uv run --with pandas script.py` for one-off dependencies; pip works too), git, gh, build-essential, sqlite3, jq, ripgrep, fd,",
					"ImageMagick (`magick`), ffmpeg, pandoc, poppler-utils (pdftotext), Noto CJK fonts, and internet access.",
					`The working directory is ${WORKSPACE}; its files persist for this conversation and the user can browse them in the app. Commands run as root inside the container.`,
					"Use it to clone repositories, run code and tests, and process data.",
					"git and gh are signed in to the user's GitHub account through the sandbox's proxy when GitHub is connected (the GH_TOKEN inside is a placeholder; do not run gh auth login).",
					"Reads run directly. Writes (git push, gh pr create, gh api with POST/PATCH/PUT/DELETE, GraphQL mutations) wait for the user to approve them on the phone and fail with 'pi mobile: ...' when declined.",
					"Set git user.name and user.email before committing if they are missing.",
					"gcloud is installed. When the user connected Google Cloud in the app, it is signed in the same way (a placeholder access token; do not run gcloud auth login), with the default project set; calls that change resources wait for the user's approval. Otherwise gcloud fails with 'pi mobile: ...'.",
					"cf (Cloudflare's CLI) and wrangler are installed and, when the user connected Cloudflare in the app, signed in the same way through CLOUDFLARE_API_TOKEN (a placeholder; do not run cf auth login or wrangler login), with CLOUDFLARE_ACCOUNT_ID set; anything but reads waits for approval.",
					"To show the user an image you made (a chart, a converted photo, a screenshot), save it as PNG or JPEG, at most 2000 px wide and 3 MB (shrink with `magick in.png -resize 1600x1600\> out.png`), and `read` it: the app shows images from read results inline in the chat.",
				].join(" "),
		),
	],
});

export const SandboxTools = createCodingTools();
