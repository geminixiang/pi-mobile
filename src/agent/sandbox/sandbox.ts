// Where the agent's coding tools (read, write, edit, bash) run off the phone: one of the user's computers running
// pi-mobile serve (host.ts), either directly as its user from home, or in the Linux container shared by all bots (as
// Grok Bot shares one computer), each bot working in its own folder there.
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { type Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { BotIndex } from "../bots.ts";
import { type DaemonArch, type DaemonOs, shellQuote } from "./daemon.ts";
import type { StreamConnection } from "./stream-connection.ts";
import { WORKSPACE } from "./workspace.ts";

/** The one container's name: pim-main. */
export const SHARED_SANDBOX = "main";

export interface Sandbox {
	/** Whether the tools run on the machine itself, from its home directory: no bot folders are made or deleted there. */
	readonly direct: boolean;
	/** A bot's folder there (the home directory when direct): its working directory, where tool paths resolve. */
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

export const IMAGES =
	"To show an image, save PNG or JPEG of at most 2000 px and 3 MB (`magick in.png -resize 1600x1600\\> out.png`) and `read` it.";

/**
 * Environments over one daemon connection: one per bot folder (same id, so writes to a file serialize across bots),
 * plus one at the base for creating, testing, and removing folders.
 */
export class SharedEnvs {
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

/** The shared container: the same image and proxy on every computer. */
export function containerDescription(folder: string): string {
	return [
		`read, write, edit, and bash run in a Linux sandbox on the user's computer, not the phone, shared by all of the user's bots: Debian 13 as root, with internet,`,
		"Node 24, Python 3.13 with uv (`uv run --with pandas x.py`), git, gh, build tools, sqlite3, jq, rg, fd, magick, ffmpeg, pandoc, pdftotext, CJK fonts.",
		`Your folder is ${WORKSPACE}/${folder}: the working directory, where relative paths resolve; it persists and the user can browse it. Other bots have folders next to it: read them when the user refers to another bot's work, but write only in yours unless asked.`,
		"Credentials stay on the phone: when connected in the app, a proxy signs in git and gh, gcloud (default project set), and cf and wrangler (CLOUDFLARE_ACCOUNT_ID set). Their tokens are placeholders; never run any auth login.",
		"Azure: once per sandbox `az login --identity --allow-no-subscriptions`, then `az account set -s $AZURE_SUBSCRIPTION_ID` if set.",
		"Before the first git command that talks to GitHub, run `gh auth setup-git` once (git then signs in through gh), and if `git config --global user.email` is empty, set user.name and user.email from `gh api user` (email: the account's, else <id>+<login>@users.noreply.github.com), so commits are the user's.",
		"When the phone is not connected, GitHub is anonymous and the others fail with 'pi mobile: ...'.",
		IMAGES,
	].join(" ");
}

/** What a bot operating one of the user's computers directly is told; `process` is what macOS asks permissions for. */
export function directDescription(name: string, user: string, system: { os: DaemonOs; arch: DaemonArch; home: string } | undefined, process: string): string {
	const where = system ? `${name} (${system.os === "darwin" ? "macOS" : "Linux"} ${system.arch})` : name;
	const desktop =
		system?.os === "darwin"
			? `\`open\` opens files, URLs, and apps; \`osascript\` drives apps and System Events; \`screencapture -x /tmp/s.png\` and then \`read\` shows the screen. macOS asks on that screen before ${process} reads protected folders (Desktop, Documents, Downloads, iCloud Drive), records the screen, or controls an app with osascript, and the command waits for the answer: when one fails with "Operation not permitted" or times out there, tell the user to allow ${process} on the computer (System Settings › Privacy & Security) rather than retrying.`
			: "`xdg-open` opens files and URLs when a desktop session is running.";
	return [
		`You operate ${where}, the user's own computer, directly as its user ${user}: read, write, edit, and bash run there (not the phone, not a container), from the home directory ${system?.home ?? "~"}, with the user's files, apps, and sign-ins (git, gh, cloud CLIs).`,
		"Work wherever on the computer the task needs, as the user would at its keyboard; find things with ls, find, and mdfind or locate rather than asking where they are.",
		desktop,
		"Do things by command first: a CLI, the app's own command line or config file, or a script (osascript reaches scriptable apps and, through System Events, settings, windows, menus, and key presses). Looking at and clicking the screen (a screen-control tool, when the user has connected one) is the fallback, for what no command or script reaches, such as a dialog that exists only on screen: there, prefer keyboard shortcuts to clicks, and check each step with a screenshot.",
		"For websites (open, read, fill in, click, sign in with the user's accounts), use ego-browser when `command -v ego-browser` finds it: run `ego-browser skill` once and follow its guide, and do not click a browser on the screen.",
		"Use the tools installed there; check with `command -v` before relying on one. Keep scratch files in a temp directory, not in home.",
		IMAGES,
	].join(" ");
}

/** The section a bot's model sees, from the sandbox that bot works in, for its folder; none on the phone. */
export function createSandboxExtension(sandboxOf: (conversationId: string) => Sandbox | undefined, folderOf: (conversationId: string) => string | undefined) {
	return defineExtension({
		name: "sandbox",
		sections: [
			section("sandbox", async (input, context) => {
				const folder = folderOf(String(input.conversationId));
				const sandbox = sandboxOf(String(input.conversationId));
				if (!folder || !sandbox) return undefined;
				if (sandbox.direct) return sandbox.describe(folder);
				// Folders are named by id, so say whose the others are.
				const others = ((await input.read.snapshot(BotIndex, context))?.items ?? []).filter((bot) => bot.folder !== folder);
				const whose = others.length > 0 ? ` The other bots' folders: ${others.map((bot) => `${bot.folder} (${bot.name})`).join(", ")}.` : "";
				return sandbox.describe(folder) + whose;
			}),
		],
	});
}

export const SandboxTools = createCodingTools();
