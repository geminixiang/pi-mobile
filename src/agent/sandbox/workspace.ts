import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ExecutionEnv, type FileInfo, getOrThrow } from "@earendil-works/pi-durable/env";
import { shellQuote } from "../../shell.ts";
import { extensionOf, mimeTypeOf } from "../../mime.ts";

const gitIn = (repo: string) => `git -C ${shellQuote(repo)} -c core.quotePath=false`;

const context = BACKGROUND_CONTEXT;
export const WORKSPACE = "/workspace";
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_DIFF_CHARS = 1_500_000;

export type FileContent =
	| { kind: "text"; text: string; truncated: boolean; size: number; limit: number }
	| { kind: "image"; url: string; size: number }
	| { kind: "binary"; size: number };

export interface Change {
	status: string;
	path: string;
	added?: number;
	removed?: number;
}

interface Commit {
	hash: string;
	subject: string;
	author: string;
	time: number;
}

interface RepoStatus {
	path: string;
	branch: string;
	ahead: number;
	behind: number;
	changes: Change[];
	commits: Commit[];
}

export const isHtml = (path: string): boolean => /^html?$/.test(extensionOf(path));

export class Workspace {
	readonly #env: ExecutionEnv;
	readonly root: string;
	readonly git: boolean;

	constructor(env: ExecutionEnv, root: string, options: { git: boolean }) {
		this.#env = env;
		this.root = root;
		this.git = options.git;
	}

	async list(path: string): Promise<FileInfo[]> {
		return getOrThrow(await this.#env.listDir(path, context)).sort((a, b) => {
			const dirA = a.kind === "directory" ? 0 : 1;
			const dirB = b.kind === "directory" ? 0 : 1;
			return dirA - dirB || a.name.localeCompare(b.name);
		});
	}

	async read(path: string): Promise<FileContent> {
		const { size } = getOrThrow(await this.#env.fileInfo(path, context));
		const type = mimeTypeOf(path);
		if (type?.startsWith("image/") && size <= MAX_IMAGE_BYTES) {
			return { kind: "image", url: URL.createObjectURL(new Blob([(await this.bytes(path)) as Uint8Array<ArrayBuffer>], { type })), size };
		}
		const limit = isHtml(path) ? MAX_HTML_BYTES : MAX_TEXT_BYTES;
		const reader = getOrThrow(await this.#env.openBinaryReader(path, undefined, context));
		const bytes = getOrThrow(await reader.read(0, limit, context).finally(() => reader.close(context)));
		if (bytes.subarray(0, 8000).includes(0)) return { kind: "binary", size };
		return { kind: "text", text: new TextDecoder().decode(bytes), truncated: size > limit, size, limit };
	}

	async bytes(path: string): Promise<Uint8Array> {
		return getOrThrow(await this.#env.readBinaryFile(path, context));
	}

	async repos(): Promise<string[]> {
		const found = await this.#exec(
			`find ${shellQuote(this.root)} -maxdepth 4 -name .git -not -path '*/node_modules/*' -prune -print 2>/dev/null | sort`,
		);
		return found
			.split("\n")
			.filter(Boolean)
			.map((path) => path.replace(/\/\.git$/, ""));
	}

	async status(repo: string): Promise<RepoStatus> {
		const git = gitIn(repo);
		const out = await this.#exec(
			[
				`${git} status --porcelain=v1 -b --untracked-files=all`,
				"echo @@NUMSTAT",
				`${git} diff HEAD --numstat 2>/dev/null`,
				"echo @@LOG",
				`${git} log -n 15 --format='%h%x09%at%x09%an%x09%s' 2>/dev/null`,
			].join("; "),
		);
		const [statusPart = "", rest = ""] = out.split("@@NUMSTAT\n");
		const [numstatPart = "", logPart = ""] = rest.split("@@LOG\n");
		const lines = statusPart.split("\n").filter(Boolean);
		const head = lines[0]?.startsWith("## ") ? (lines.shift() ?? "") : "";
		const branch = /^## (?:No commits yet on )?([^.\s]+)/.exec(head)?.[1] ?? "HEAD";
		const counts = new Map<string, { added: number; removed: number }>();
		for (const line of numstatPart.split("\n").filter(Boolean)) {
			const [added, removed, ...path] = line.split("\t");
			counts.set(path.join("\t"), { added: Number(added) || 0, removed: Number(removed) || 0 });
		}
		const changes = lines.map((line) => {
			const status = line.slice(0, 2);
			const path = line.slice(3).replace(/^.* -> /, "");
			return { status, path, ...counts.get(path) };
		});
		const commits = logPart
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [hash = "", time = "0", author = "", ...subject] = line.split("\t");
				return { hash, time: Number(time) * 1000, author, subject: subject.join("\t") };
			});
		return {
			path: repo,
			branch,
			ahead: Number(/ahead (\d+)/.exec(head)?.[1] ?? 0),
			behind: Number(/behind (\d+)/.exec(head)?.[1] ?? 0),
			changes,
			commits,
		};
	}

	async diff(repo: string, change: Change): Promise<string> {
		const git = gitIn(repo);
		const command =
			change.status === "??"
				? `${git} diff --no-color --no-index -- /dev/null ${shellQuote(change.path)}`
				: `${git} diff HEAD --no-color --no-ext-diff -- ${shellQuote(change.path)} 2>/dev/null || ${git} diff --cached --no-color -- ${shellQuote(change.path)}`;
		return this.#exec(command);
	}

	async show(repo: string, hash: string): Promise<string> {
		const git = gitIn(repo);
		return this.#exec(`${git} show --no-color --no-ext-diff --format='%H%n%an <%ae>%n%ad%n%n%B' ${shellQuote(hash)}`);
	}

	async #exec(command: string): Promise<string> {
		let stdout = "";
		const result = await this.#env.exec(
			command,
			{
				cwd: this.root,
				timeout: 30_000,
				onOutput: (text, _context, info) => {
					if (info.stream !== "stderr" && stdout.length < MAX_DIFF_CHARS) stdout += text;
				},
			},
			context,
		);
		if (!result.ok) throw result.error;
		return stdout;
	}
}
