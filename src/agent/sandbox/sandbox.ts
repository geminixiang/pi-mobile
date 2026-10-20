// Remote sandbox: a Linux container per conversation on the user's own machine (a Mac or Linux host over Tailscale),
// reached through the relay in sandbox/relay. Durable's coding tools (read, write, edit, bash) run there.
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { type Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { Type } from "typebox";
import { log } from "../../log.ts";
import { parse } from "../parse.ts";
import { WebSocketConnection } from "./ws-connection.ts";

export interface SandboxConfig {
	/** ws://host:port of the relay. */
	url: string;
	token: string;
}

const WORKSPACE = "/workspace";
const SandboxIds = Type.Array(Type.Object({ id: Type.String() }));

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
				onLog: (text) => log.warn("sandbox.daemon_output", { sandbox: name, text }),
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
		return parse(SandboxIds, await response.json(), "sandbox 清單").some((sandbox) => sandbox.id === name);
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
					"read, write, edit, and bash run in this conversation's Linux sandbox on the user's computer, not the phone: Debian 13 arm64 as root, with internet,",
					"Node 24, Python 3.13 with uv (`uv run --with pandas x.py`), git, gh, build tools, sqlite3, jq, rg, fd, magick, ffmpeg, pandoc, pdftotext, CJK fonts.",
					`${WORKSPACE} persists, and the user can browse it.`,
					"Credentials stay on the phone: when connected in the app, a proxy signs in git and gh, gcloud (default project set), and cf and wrangler (CLOUDFLARE_ACCOUNT_ID set). Their tokens are placeholders; never run any auth login.",
					"Azure: once per sandbox `az login --identity --allow-no-subscriptions`, then `az account set -s $AZURE_SUBSCRIPTION_ID` if set.",
					"Reads run directly. Writes (push, PRs, POST/PATCH/PUT/DELETE, resource changes, listKeys) wait for approval on the phone and fail with 'pi mobile: ...' when declined or not connected. Set git user.name and user.email if missing.",
					"To show an image, save PNG or JPEG of at most 2000 px and 3 MB (`magick in.png -resize 1600x1600\\> out.png`) and `read` it.",
				].join(" "),
		),
	],
});

export const SandboxTools = createCodingTools();
