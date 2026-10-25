import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { type Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { BotIndex } from "../bots.ts";
import { type DaemonArch, type DaemonOs, shellQuote } from "./daemon.ts";
import type { ConnectionStatus, StreamConnection } from "./stream-connection.ts";
import { WORKSPACE } from "./workspace.ts";
import { SHOWN_AS_FILE } from "../files/extension.ts";
import type { Workplace } from "../workplaces.ts";
import { onFailure } from "../../promise.ts";

export const SHARED_SANDBOX = "main";

export interface Sandbox {
	readonly direct: boolean;
	readonly status: ConnectionStatus;
	subscribe(listener: (status: ConnectionStatus) => void): () => void;
	root(folder: string): string;
	env(folder: string): Promise<ExecutionEnv>;
	exists(folder: string): Promise<boolean>;
	remove(folder: string): Promise<void>;
	describe(folder: string): string;
	close(): void;
}

const IMAGES =
	"To show an image, save PNG or JPEG of at most 2000 px and 3 MB (`magick in.png -resize 1600x1600\\> out.png`) and `read` it.";

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
		return new RemoteExecutionEnv({ connection: this.#asConnection(), id: `sandbox:${SHARED_SANDBOX}`, cwd });
	}

	#asConnection(): Connection {
		// why: pi-env's Connection is a class with private fields, so no reimplementation is assignable to it; StreamConnection has its whole public API (info, session, request, close, kill), which is all RemoteExecutionEnv calls.
		return this.#connection as unknown as Connection;
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
			onFailure(made, () => this.#made.delete(folder));
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
		SHOWN_AS_FILE,
	].join(" ");
}

export function directDescription(name: string, user: string, system: { os: DaemonOs; arch: DaemonArch; home: string } | undefined, process: string): string {
	const where = system ? `${name} (${system.os === "darwin" ? "macOS" : "Linux"} ${system.arch})` : name;
	const desktop =
		system?.os === "darwin"
			? `Commands first: CLIs, \`open\`, and \`osascript\` (scriptable apps; System Events for settings, windows, menus, keys). If one fails with "Operation not permitted" or times out, macOS is asking on the computer: tell the user to allow ${process} there.`
			: "Commands first; `xdg-open` opens files and URLs when a desktop session is running.";
	return [
		`You operate ${where}, the user's own computer, as ${user}: read, write, edit, and bash run there from ${system?.home ?? "~"}, with the user's files, apps, and sign-ins. Find things yourself (ls, find, mdfind) rather than asking.`,
		desktop,
		"The screen is the fallback for what no command reaches (a dialog, what a window shows): read_screen to look, use_screen to click and type; keys over clicks.",
		"Websites: ego-browser if `command -v ego-browser` finds it (run `ego-browser skill` once and follow it), never by clicking a browser.",
		"Scratch files go in a temp directory.",
		IMAGES,
		SHOWN_AS_FILE,
	].join(" ");
}

export function createSandboxExtension(workplace: (conversationId: string) => Workplace | undefined) {
	return defineExtension({
		name: "sandbox",
		sections: [
			section("sandbox", async (input, context) => {
				const place = workplace(String(input.conversationId));
				if (place?.kind !== "computer") return undefined;
				const { folder, sandbox } = place;
				if (sandbox.direct) return sandbox.describe(folder);
				const others = ((await input.read.snapshot(BotIndex, context))?.items ?? []).filter((bot) => bot.folder !== folder);
				const whose = others.length > 0 ? ` The other bots' folders: ${others.map((bot) => `${bot.folder} (${bot.name})`).join(", ")}.` : "";
				return sandbox.describe(folder) + whose;
			}),
		],
	});
}

export const SandboxTools = createCodingTools();
