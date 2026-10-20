// Read-only view of a conversation's sandbox for the app: browse its folder, read files, and inspect git
// repositories (changes against HEAD and recent commits). Everything runs through the same pi-env connection the
// agent's tools use.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv, FileInfo } from "@earendil-works/pi-durable/env";

const context = BACKGROUND_CONTEXT;
/** The conversation's folder in a container sandbox. */
export const WORKSPACE = "/workspace";
/** Larger files are cut; the viewer says so. */
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_DIFF_CHARS = 1_500_000;
const IMAGE_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
};

export type FileEntry = FileInfo;

export type FileContent =
	| { kind: "text"; text: string; truncated: boolean; size: number }
	| { kind: "image"; url: string; size: number }
	| { kind: "binary"; size: number };

export interface Change {
	/** Two-letter porcelain status, e.g. " M", "A ", "??". */
	status: string;
	path: string;
	added?: number;
	removed?: number;
}

export interface Commit {
	hash: string;
	subject: string;
	author: string;
	time: number;
}

export interface RepoStatus {
	/** Absolute path of the work tree. */
	path: string;
	branch: string;
	/** Commits ahead of and behind the upstream, when there is one. */
	ahead: number;
	behind: number;
	changes: Change[];
	commits: Commit[];
}

function quote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function extension(path: string): string {
	return /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
}

function looksBinary(bytes: Uint8Array): boolean {
	const sample = bytes.subarray(0, 8000);
	return sample.includes(0);
}

export class Workspace {
	readonly #env: ExecutionEnv;
	/** The conversation's folder: /workspace in a container, a folder in the user's home on a trusted machine. */
	readonly root: string;

	constructor(env: ExecutionEnv, root: string) {
		this.#env = env;
		this.root = root;
	}

	async list(path: string): Promise<FileEntry[]> {
		const result = await this.#env.listDir(path, context);
		if (!result.ok) throw result.error;
		return result.value.sort((a, b) => {
			const dirA = a.kind === "directory" ? 0 : 1;
			const dirB = b.kind === "directory" ? 0 : 1;
			return dirA - dirB || a.name.localeCompare(b.name);
		});
	}

	async read(path: string): Promise<FileContent> {
		const info = await this.#env.fileInfo(path, context);
		if (!info.ok) throw info.error;
		const size = info.value.size;
		const type = IMAGE_TYPES[extension(path)];
		if (type && size <= MAX_IMAGE_BYTES) {
			const bytes = await this.#env.readBinaryFile(path, context);
			if (!bytes.ok) throw bytes.error;
			return { kind: "image", url: URL.createObjectURL(new Blob([bytes.value as Uint8Array<ArrayBuffer>], { type })), size };
		}
		// Read only the head of large files: the viewer is for looking, not for loading whole logs.
		// `base64 | tr` rather than GNU's `base64 -w0`: a trusted machine may be a Mac.
		const head = await this.#exec(`head -c ${MAX_TEXT_BYTES} -- ${quote(path)} | base64 | tr -d '\\n'`);
		const bytes = Uint8Array.from(atob(head.stdout.trim()), (char) => char.charCodeAt(0));
		if (looksBinary(bytes)) return { kind: "binary", size };
		return { kind: "text", text: new TextDecoder().decode(bytes), truncated: size > MAX_TEXT_BYTES, size };
	}

	/** Git work trees under the root, up to three levels deep. */
	async repos(): Promise<string[]> {
		const found = await this.#exec(
			`find ${quote(this.root)} -maxdepth 4 -name .git -not -path '*/node_modules/*' -prune -print 2>/dev/null | sort`,
		);
		return found.stdout
			.split("\n")
			.filter(Boolean)
			.map((path) => path.replace(/\/\.git$/, ""));
	}

	async status(repo: string): Promise<RepoStatus> {
		const git = `git -C ${quote(repo)} -c core.quotePath=false`;
		// One round trip: sections separated by marker lines.
		const out = await this.#exec(
			[
				`${git} status --porcelain=v1 -b --untracked-files=all`,
				"echo @@NUMSTAT",
				`${git} diff HEAD --numstat 2>/dev/null`,
				"echo @@LOG",
				`${git} log -n 15 --format='%h%x09%at%x09%an%x09%s' 2>/dev/null`,
			].join("; "),
		);
		const [statusPart = "", rest = ""] = out.stdout.split("@@NUMSTAT\n");
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

	/** Unified diff of one changed file against HEAD; untracked files show as all added. */
	async diff(repo: string, change: Change): Promise<string> {
		const git = `git -C ${quote(repo)} -c core.quotePath=false`;
		const command =
			change.status === "??"
				? `${git} diff --no-color --no-index -- /dev/null ${quote(change.path)}`
				: `${git} diff HEAD --no-color --no-ext-diff -- ${quote(change.path)} 2>/dev/null || ${git} diff --cached --no-color -- ${quote(change.path)}`;
		return (await this.#exec(command)).stdout;
	}

	/** A commit's message and patch. */
	async show(repo: string, hash: string): Promise<string> {
		const git = `git -C ${quote(repo)} -c core.quotePath=false`;
		return (await this.#exec(`${git} show --no-color --no-ext-diff --format='%H%n%an <%ae>%n%ad%n%n%B' ${quote(hash)}`)).stdout;
	}

	async #exec(command: string): Promise<{ code: number; stdout: string; stderr: string }> {
		let stdout = "";
		let stderr = "";
		const result = await this.#env.exec(
			command,
			{
				cwd: this.root,
				timeout: 30_000,
				onOutput: (text, _context, info) => {
					if (info.stream === "stderr") stderr += text;
					else if (stdout.length < MAX_DIFF_CHARS) stdout += text;
				},
			},
			context,
		);
		if (!result.ok) throw result.error;
		return { code: result.value.exitCode, stdout, stderr };
	}
}
