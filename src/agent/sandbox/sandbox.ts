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
					"read, write, edit, and bash run in this conversation's own Linux sandbox, not on the phone:",
					"a Debian container (arm64) on the user's Raspberry Pi with Node 22, Python 3.11, git, build-essential, ripgrep, and internet access.",
					`The working directory is ${WORKSPACE}; its files persist for this conversation. Commands run as root inside the container.`,
					"Use it to clone repositories, run code and tests, and process data. It has no GitHub credentials; use the github_* tools for the GitHub API.",
				].join(" "),
		),
	],
});

export const SandboxTools = createCodingTools();
