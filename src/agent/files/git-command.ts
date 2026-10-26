import { type Command, defineCommand, type IFileSystem } from "just-bash/browser";
import type { FolderFetch } from "./folder-fetch.ts";

const WRITES_COMMITS = new Set(["commit", "merge", "rebase", "cherry-pick", "revert", "tag", "stash", "pull"]);
const TAKES_VALUE = new Set(["-C", "-c"]);

function subcommand(args: readonly string[]): string | undefined {
	for (let at = 0; at < args.length; at++) {
		const arg = args[at];
		if (arg === undefined) return undefined;
		if (TAKES_VALUE.has(arg)) at++;
		else if (!arg.startsWith("-")) return arg;
	}
	return undefined;
}

type Account = { login: string; id: number; name: string | null };

function isAccount(value: unknown): value is Account {
	if (typeof value !== "object" || value === null) return false;
	const login = Reflect.get(value, "login");
	const id = Reflect.get(value, "id");
	const name = Reflect.get(value, "name");
	return typeof login === "string" && typeof id === "number" && (typeof name === "string" || name === null);
}

async function githubIdentity(fetch: FolderFetch): Promise<{ name: string; email: string } | undefined> {
	const response = await fetch("https://api.github.com/user", { headers: { Accept: "application/vnd.github+json" } });
	if (!response.ok) return undefined;
	const account: unknown = await response.json();
	if (!isAccount(account)) return undefined;
	return { name: account.name || account.login, email: `${account.id}+${account.login}@users.noreply.github.com` };
}

const NO_LINKS = new Set<PropertyKey>(["symlink", "readlink", "link"]);

function withoutLinks(fs: IFileSystem): IFileSystem {
	return new Proxy(fs, {
		get(target, key) {
			if (NO_LINKS.has(key)) return undefined;
			const value: unknown = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

export function gitCommand(fetch: FolderFetch): Command {
	return defineCommand("git", async (args, ctx) => {
		const { createGit } = await import("just-git");
		const command = subcommand(args);
		const identity = WRITES_COMMITS.has(command ?? "") ? await githubIdentity(fetch) : undefined;
		const git = createGit({ network: { allowed: ["github.com"], fetch }, ...(identity ? { identity } : {}) });
		const context = { ...ctx, fs: withoutLinks(ctx.fs) };
		const end = args.indexOf("--");
		const checking = command === "diff" && args.slice(0, end < 0 ? args.length : end).includes("--check");
		if (command === "cat-file" || checking) {
			if (args[0] !== command) return { stdout: "", stderr: "git: global options are not supported for inspection commands\n", exitCode: 129 };
			const { catFile, diffCheck } = await import("./git-inspection.ts");
			return command === "cat-file" ? catFile(git, args.slice(1), context) : diffCheck(git, args.slice(1), context);
		}
		return git.execute(args, context);
	});
}
