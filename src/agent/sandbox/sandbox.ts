// Where the agent's coding tools (read, write, edit, bash) run for a conversation, on the user's own machine:
// - relay: a Linux container per conversation behind the sandbox relay (sandbox/relay), credentials through its proxy;
// - machine: one of the user's machines over SSH, the daemon running as the SSH user in a folder per conversation
//   ("trusted", docs/design/sandbox-ssh.md).
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { type Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { Type } from "typebox";
import { log } from "../../log.ts";
import { parse } from "../parse.ts";
import { ContainerHost, type Credentials } from "./container.ts";
import { type Machine, MachineLink, type MachineSystem, shellQuote } from "./machine.ts";
import { StreamConnection } from "./stream-connection.ts";
import { WORKSPACE } from "./workspace.ts";
import { WebSocketConnection } from "./ws-connection.ts";

export interface RelayConfig {
	/** ws://host:port of the relay. */
	url: string;
	token: string;
}

const SandboxIds = Type.Array(Type.Object({ id: Type.String() }));

export function sandboxName(conversationId: ConversationId): string {
	return `c${String(conversationId)}`;
}

/** One conversation's environment and the connection behind it, kept while the app runs. */
interface Entry {
	env: RemoteExecutionEnv;
	connection: StreamConnection;
}

export interface Sandbox {
	readonly kind: "relay" | "machine";
	/** The conversation's folder there; tool paths are relative to it. */
	root(conversationId: ConversationId): string;
	env(conversationId: ConversationId): ExecutionEnv;
	/** Whether the conversation has used it already; browsing files should not create anything. */
	exists(conversationId: ConversationId): Promise<boolean>;
	/** Delete the conversation's files there (and its container). */
	remove(conversationId: ConversationId): Promise<void>;
	/** What the model is told about where its tools run. */
	describe(): string;
	close(): void;
}

function envFor(entries: Map<string, Entry>, name: string, cwd: string, connect: () => StreamConnection): RemoteExecutionEnv {
	let entry = entries.get(name);
	if (!entry) {
		const connection = connect();
		// RemoteExecutionEnv only uses info/session/request/kill/close, which StreamConnection implements.
		const env = new RemoteExecutionEnv({ connection: connection as unknown as Connection, id: `sandbox:${name}`, cwd });
		entry = { env, connection };
		entries.set(name, entry);
	}
	return entry.env;
}

const IMAGES =
	"To show an image, save PNG or JPEG of at most 2000 px and 3 MB (`magick in.png -resize 1600x1600\\> out.png`) and `read` it.";

/** A container per conversation behind the sandbox relay. */
export class RelaySandbox implements Sandbox {
	readonly kind = "relay";
	readonly #config: RelayConfig;
	readonly #entries = new Map<string, Entry>();

	constructor(config: RelayConfig) {
		this.#config = config;
	}

	root(): string {
		return WORKSPACE;
	}

	env(conversationId: ConversationId): ExecutionEnv {
		const name = sandboxName(conversationId);
		return envFor(this.#entries, name, WORKSPACE, () =>
			new WebSocketConnection({
				relayUrl: this.#config.url,
				relayToken: this.#config.token,
				sandbox: name,
				onLog: (text) => log.warn("sandbox.daemon_output", { sandbox: name, text }),
			}),
		);
	}

	async exists(conversationId: ConversationId): Promise<boolean> {
		const name = sandboxName(conversationId);
		if (this.#entries.has(name)) return true;
		const url = new URL("/sandboxes", this.#config.url.replace(/^ws/, "http"));
		url.searchParams.set("token", this.#config.token);
		const response = await fetch(url);
		if (!response.ok) throw new Error(`Listing sandboxes failed: HTTP ${response.status}`);
		return parse(SandboxIds, await response.json(), "sandbox 清單").some((sandbox) => sandbox.id === name);
	}

	async remove(conversationId: ConversationId): Promise<void> {
		const name = sandboxName(conversationId);
		this.#entries.get(name)?.connection.close();
		this.#entries.delete(name);
		const url = new URL(`/sandboxes/${name}`, this.#config.url.replace(/^ws/, "http"));
		url.searchParams.set("token", this.#config.token);
		const response = await fetch(url, { method: "DELETE" });
		if (!response.ok) throw new Error(`Removing the sandbox failed: HTTP ${response.status}`);
	}

	describe(): string {
		return containerDescription();
	}

	close(): void {
		for (const { connection } of this.#entries.values()) connection.close();
		this.#entries.clear();
	}
}

/** A container sandbox, behind the relay or reached over SSH: the same image and the same proxy. */
function containerDescription(): string {
		return [
			"read, write, edit, and bash run in this conversation's Linux sandbox on the user's computer, not the phone: Debian 13 as root, with internet,",
			"Node 24, Python 3.13 with uv (`uv run --with pandas x.py`), git, gh, build tools, sqlite3, jq, rg, fd, magick, ffmpeg, pandoc, pdftotext, CJK fonts.",
			`${WORKSPACE} persists, and the user can browse it.`,
			"Credentials stay on the phone: when connected in the app, a proxy signs in git and gh, gcloud (default project set), and cf and wrangler (CLOUDFLARE_ACCOUNT_ID set). Their tokens are placeholders; never run any auth login.",
			"Azure: once per sandbox `az login --identity --allow-no-subscriptions`, then `az account set -s $AZURE_SUBSCRIPTION_ID` if set.",
			"Reads run directly. Writes (push, PRs, POST/PATCH/PUT/DELETE, resource changes, listKeys) wait for approval on the phone and fail with 'pi mobile: ...' when declined or not connected. Set git user.name and user.email if missing.",
			IMAGES,
		].join(" ");
}

/** Folders per conversation, below the SSH user's home on a trusted machine. */
const FOLDER = "pi-workspaces";

function systemLabel(system: MachineSystem): string {
	return `${system.os === "darwin" ? "macOS" : "Linux"} ${system.arch}`;
}

/**
 * One of the user's machines over SSH. With a container engine there (and not set to trusted), a container per
 * conversation behind the egress proxy, whose questions the phone answers: credentials stay on the phone and writes
 * wait for approval, as with the relay. Otherwise the daemon runs as the SSH user in a folder per conversation.
 */
export class MachineSandbox implements Sandbox {
	readonly kind = "machine";
	readonly #link: MachineLink;
	readonly #entries = new Map<string, Entry>();
	readonly #containers: ContainerHost | undefined;
	readonly #credentials: Credentials;
	readonly #stopBridge: (() => void) | undefined;

	constructor(machine: Machine, credentials: Credentials) {
		this.#link = new MachineLink(machine);
		this.#credentials = credentials;
		const engine = machine.system?.engines[0];
		if (engine && machine.mode !== "trusted") {
			this.#containers = new ContainerHost(engine, () => this.#link.client());
			this.#stopBridge = this.#containers.bridge(credentials);
		}
	}

	get machine(): Machine {
		return this.#link.machine;
	}

	/** Whether the agent works in containers there rather than as the SSH user. */
	get contained(): boolean {
		return this.#containers !== undefined;
	}

	root(conversationId: ConversationId): string {
		if (this.#containers) return WORKSPACE;
		const home = this.machine.system?.home ?? "~";
		return `${home}/${FOLDER}/${sandboxName(conversationId)}`;
	}

	env(conversationId: ConversationId): ExecutionEnv {
		const name = sandboxName(conversationId);
		const cwd = this.root(conversationId);
		const onLog = (text: string) => log.warn("sandbox.daemon_output", { machine: this.machine.name, sandbox: name, text });
		const containers = this.#containers;
		if (containers) {
			// Per-service settings from the phone, such as the default Google Cloud project or Cloudflare account.
			const serviceEnv = () => Object.assign({}, ...Object.values(this.#credentials.minted).map((service) => service.env));
			return envFor(this.#entries, name, cwd, () => new StreamConnection({ open: containers.opener(name, serviceEnv), onLog }));
		}
		return envFor(this.#entries, name, cwd, () => this.#link.connection(cwd, onLog));
	}

	async exists(conversationId: ConversationId): Promise<boolean> {
		const name = sandboxName(conversationId);
		if (this.#entries.has(name)) return true;
		if (this.#containers) return this.#containers.exists(name);
		const client = await this.#link.client();
		return (await client.run(`test -d ${shellQuote(this.root(conversationId))}`)).code === 0;
	}

	async remove(conversationId: ConversationId): Promise<void> {
		const name = sandboxName(conversationId);
		this.#entries.get(name)?.connection.close();
		this.#entries.delete(name);
		if (this.#containers) {
			await this.#containers.remove(name);
			return;
		}
		const client = await this.#link.client();
		const removed = await client.run(`rm -rf -- ${shellQuote(this.root(conversationId))}`);
		if (removed.code !== 0) throw new Error(`刪除資料夾失敗：${removed.stderr.trim()}`);
	}

	describe(): string {
		if (this.#containers) return containerDescription();
		const machine = this.machine;
		const where = machine.system ? `${machine.name} (${systemLabel(machine.system)})` : machine.name;
		return [
			`read, write, edit, and bash run on ${where}, the user's own machine, as its user ${machine.user}, not the phone and not a container.`,
			`The working directory is this conversation's folder ~/${FOLDER}/<conversation>; relative paths resolve there, and the user can browse it. Keep your work inside it.`,
			"Use the tools installed there as they are; check with `command -v` before relying on one, and install into the folder (venv, node_modules) rather than system-wide.",
			"Its git, gh, and cloud CLIs use the machine's own sign-ins, and nothing there is approved on the phone: before pushing, deploying, deleting, or changing anything outside the folder, say what you will do and wait for the user's go-ahead.",
			IMAGES,
		].join(" ");
	}

	close(): void {
		this.#stopBridge?.();
		for (const { connection } of this.#entries.values()) connection.close();
		this.#entries.clear();
		this.#link.close();
	}
}

/** The section the model sees, from whichever sandbox the app has. */
export function createSandboxExtension(sandbox: Sandbox) {
	return defineExtension({
		name: "sandbox",
		sections: [section("sandbox", () => sandbox.describe())],
	});
}

export const SandboxTools = createCodingTools();
