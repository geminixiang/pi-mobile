// Where the agent's coding tools (read, write, edit, bash) run, on the user's own machine. One sandbox shared by all
// bots (as Grok Bot shares one computer), each bot working in its own folder there:
// - relay: a Linux container behind the sandbox relay (sandbox/relay), credentials through its proxy;
// - machine: one of the user's machines over SSH, in a container behind the egress proxy when an engine answers there,
//   else as the SSH user ("trusted", docs/design/sandbox-ssh.md).
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { type Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { log } from "../../log.ts";
import { BotIndex } from "../bots.ts";
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

/** The one sandbox's name: its container is sbx-main behind the relay, pim-main over SSH. */
export const SHARED_SANDBOX = "main";
/** Folders below the SSH user's home on a trusted machine. */
const TRUSTED_BASE = "pi-workspaces";

export interface Sandbox {
	readonly kind: "relay" | "machine";
	/** A bot's folder there: its working directory, where tool paths resolve. */
	root(folder: string): string;
	env(folder: string): Promise<ExecutionEnv>;
	/** Whether the folder exists already; browsing files should not create it. */
	exists(folder: string): Promise<boolean>;
	/** Delete a bot's folder and everything in it. */
	remove(folder: string): Promise<void>;
	/** What a bot's model is told about where its tools run. */
	describe(folder: string): string;
	close(): void;
}

const IMAGES =
	"To show an image, save PNG or JPEG of at most 2000 px and 3 MB (`magick in.png -resize 1600x1600\\> out.png`) and `read` it.";

/**
 * Environments over one daemon connection: one per bot folder (same id, so writes to a file serialize across bots),
 * plus one at the base for creating, testing, and removing folders.
 */
class SharedEnvs {
	readonly #connection: StreamConnection;
	readonly #base: string;
	readonly #root: (folder: string) => string;
	readonly #envs = new Map<string, RemoteExecutionEnv>();
	readonly #made = new Map<string, Promise<void>>();
	readonly #baseEnv: RemoteExecutionEnv;

	constructor(connection: StreamConnection, base: string, root: (folder: string) => string) {
		this.#connection = connection;
		this.#base = base;
		this.#root = root;
		this.#baseEnv = this.#make(base);
	}

	#make(cwd: string): RemoteExecutionEnv {
		// RemoteExecutionEnv only uses info/session/request/kill/close, which StreamConnection implements.
		return new RemoteExecutionEnv({ connection: this.#connection as unknown as Connection, id: `sandbox:${SHARED_SANDBOX}`, cwd });
	}

	async #run(command: string): Promise<number> {
		const result = await this.#baseEnv.exec(command, { cwd: this.#base, timeout: 60_000 }, BACKGROUND_CONTEXT);
		if (!result.ok) throw result.error;
		return result.value.exitCode;
	}

	async env(folder: string): Promise<ExecutionEnv> {
		const root = this.#root(folder);
		let made = this.#made.get(folder);
		if (!made) {
			made = this.#run(`mkdir -p ${shellQuote(root)}`).then((code) => {
				if (code !== 0) throw new Error(`cannot create ${root}`);
			});
			made.catch(() => this.#made.delete(folder));
			this.#made.set(folder, made);
		}
		await made;
		let env = this.#envs.get(folder);
		if (!env) {
			env = this.#make(root);
			this.#envs.set(folder, env);
		}
		return env;
	}

	async exists(folder: string): Promise<boolean> {
		if (this.#envs.has(folder)) return true;
		return (await this.#run(`test -d ${shellQuote(this.#root(folder))}`)) === 0;
	}

	async remove(folder: string): Promise<void> {
		this.#envs.delete(folder);
		this.#made.delete(folder);
		if ((await this.#run(`rm -rf -- ${shellQuote(this.#root(folder))}`)) !== 0) throw new Error(`刪除 ${this.#root(folder)} 失敗`);
	}

	close(): void {
		this.#connection.close();
	}
}

/** The shared container sandbox, behind the relay or over SSH: the same image and the same proxy. */
function containerDescription(folder: string): string {
	return [
		`read, write, edit, and bash run in a Linux sandbox on the user's computer, not the phone, shared by all of the user's bots: Debian 13 as root, with internet,`,
		"Node 24, Python 3.13 with uv (`uv run --with pandas x.py`), git, gh, build tools, sqlite3, jq, rg, fd, magick, ffmpeg, pandoc, pdftotext, CJK fonts.",
		`Your folder is ${WORKSPACE}/${folder}: the working directory, where relative paths resolve; it persists and the user can browse it. Other bots have folders next to it: read them when the user refers to another bot's work, but write only in yours unless asked.`,
		"Credentials stay on the phone: when connected in the app, a proxy signs in git and gh, gcloud (default project set), and cf and wrangler (CLOUDFLARE_ACCOUNT_ID set). Their tokens are placeholders; never run any auth login.",
		"Azure: once per sandbox `az login --identity --allow-no-subscriptions`, then `az account set -s $AZURE_SUBSCRIPTION_ID` if set.",
		"Reads run directly. Writes (push, PRs, POST/PATCH/PUT/DELETE, resource changes, listKeys) wait for approval on the phone and fail with 'pi mobile: ...' when declined or not connected. Set git user.name and user.email if missing.",
		IMAGES,
	].join(" ");
}

/** The shared container behind the sandbox relay. */
export class RelaySandbox implements Sandbox {
	readonly kind = "relay";
	readonly #config: RelayConfig;
	readonly #envs: SharedEnvs;

	constructor(config: RelayConfig) {
		this.#config = config;
		const connection = new WebSocketConnection({
			relayUrl: config.url,
			relayToken: config.token,
			sandbox: SHARED_SANDBOX,
			onLog: (text) => log.warn("sandbox.daemon_output", { sandbox: SHARED_SANDBOX, text }),
		});
		this.#envs = new SharedEnvs(connection, WORKSPACE, (folder) => this.root(folder));
	}

	root(folder: string): string {
		return `${WORKSPACE}/${folder}`;
	}

	env(folder: string): Promise<ExecutionEnv> {
		return this.#envs.env(folder);
	}

	exists(folder: string): Promise<boolean> {
		return this.#envs.exists(folder);
	}

	remove(folder: string): Promise<void> {
		return this.#envs.remove(folder);
	}

	describe(folder: string): string {
		return containerDescription(folder);
	}

	/** The relay's URL, for its control channel. */
	get config(): RelayConfig {
		return this.#config;
	}

	close(): void {
		this.#envs.close();
	}
}

function systemLabel(system: MachineSystem): string {
	return `${system.os === "darwin" ? "macOS" : "Linux"} ${system.arch}`;
}

/**
 * One of the user's machines over SSH. With a container engine there (and not set to trusted), the shared container
 * behind the egress proxy, whose questions the phone answers: credentials stay on the phone and writes wait for
 * approval, as with the relay. Otherwise the daemon runs as the SSH user, with a folder per bot in ~/pi-workspaces.
 */
export class MachineSandbox implements Sandbox {
	readonly kind = "machine";
	readonly #link: MachineLink;
	readonly #containers: ContainerHost | undefined;
	readonly #stopBridge: (() => void) | undefined;
	readonly #envs: SharedEnvs;

	constructor(machine: Machine, credentials: Credentials) {
		this.#link = new MachineLink(machine);
		const engine = machine.system?.engines[0];
		const onLog = (text: string) => log.warn("sandbox.daemon_output", { machine: machine.name, text });
		if (engine && machine.mode !== "trusted") {
			const containers = new ContainerHost(engine, () => this.#link.client());
			this.#containers = containers;
			this.#stopBridge = containers.bridge(credentials);
			// Per-service settings from the phone, such as the default Google Cloud project or Cloudflare account.
			const serviceEnv = () => Object.assign({}, ...Object.values(credentials.minted).map((service) => service.env));
			const connection = new StreamConnection({ open: containers.opener(SHARED_SANDBOX, serviceEnv), onLog });
			this.#envs = new SharedEnvs(connection, WORKSPACE, (folder) => this.root(folder));
		} else {
			const base = `${machine.system?.home ?? "~"}/${TRUSTED_BASE}`;
			this.#envs = new SharedEnvs(this.#link.connection(base, onLog), base, (folder) => this.root(folder));
		}
	}

	get machine(): Machine {
		return this.#link.machine;
	}

	/** Whether the agent works in a container there rather than as the SSH user. */
	get contained(): boolean {
		return this.#containers !== undefined;
	}

	root(folder: string): string {
		if (this.#containers) return `${WORKSPACE}/${folder}`;
		return `${this.machine.system?.home ?? "~"}/${TRUSTED_BASE}/${folder}`;
	}

	env(folder: string): Promise<ExecutionEnv> {
		return this.#envs.env(folder);
	}

	exists(folder: string): Promise<boolean> {
		return this.#envs.exists(folder);
	}

	remove(folder: string): Promise<void> {
		return this.#envs.remove(folder);
	}

	describe(folder: string): string {
		if (this.#containers) return containerDescription(folder);
		const machine = this.machine;
		const where = machine.system ? `${machine.name} (${systemLabel(machine.system)})` : machine.name;
		return [
			`read, write, edit, and bash run on ${where}, the user's own machine, as its user ${machine.user}, not the phone and not a container.`,
			`Your folder is ~/${TRUSTED_BASE}/${folder}: the working directory, where relative paths resolve; the user can browse it. Other bots have folders next to it: read them when the user refers to another bot's work, but keep your work in yours.`,
			"Use the tools installed there as they are; check with `command -v` before relying on one, and install into the folder (venv, node_modules) rather than system-wide.",
			"Its git, gh, and cloud CLIs use the machine's own sign-ins, and nothing there is approved on the phone: before pushing, deploying, deleting, or changing anything outside the folder, say what you will do and wait for the user's go-ahead.",
			IMAGES,
		].join(" ");
	}

	close(): void {
		this.#stopBridge?.();
		this.#envs.close();
		this.#link.close();
	}
}

/** The section a bot's model sees, from whichever sandbox the app has, for that bot's folder. */
export function createSandboxExtension(sandbox: Sandbox, folderOf: (conversationId: string) => string | undefined) {
	return defineExtension({
		name: "sandbox",
		sections: [
			section("sandbox", async (input, context) => {
				const folder = folderOf(String(input.conversationId));
				if (!folder) return undefined;
				// Folders are named by id, so say whose the others are.
				const others = ((await input.read.snapshot(BotIndex, context))?.items ?? []).filter((bot) => bot.folder !== folder);
				const whose = others.length > 0 ? ` The other bots' folders: ${others.map((bot) => `${bot.folder} (${bot.name})`).join(", ")}.` : "";
				return sandbox.describe(folder) + whose;
			}),
		],
	});
}

export const SandboxTools = createCodingTools();
