// A bot's folder on the phone as pi-durable's ExecutionEnv, so read, write, edit, and bash work without a sandbox.
// The files are in the app's private storage (BotFilesPlugin.java, files/bots/<bot>); bash is just-bash in a Web
// Worker (shell-worker.ts), whose file operations come back here. Tool paths are absolute in the folder: "/" is its
// root and nothing outside it exists, so no path can reach the app's own data.
import type { Context } from "@earendil-works/chord";
import {
	type BinaryReader,
	type DirReader,
	type ExecutionEnv,
	ExecutionError,
	err,
	FileError,
	type FileErrorCode,
	type FileInfo,
	type FileWatcher,
	LineScanner,
	ok,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	type TextLineReader,
} from "@earendil-works/pi-durable/env";
import { BotFiles, type BotFileInfo } from "../../bot-files-plugin.ts";
import type { FromWorker, FsOp, FsValue, ToWorker } from "./protocol.ts";

/** Where temporary files go, inside the folder: bash's spilled output, pi-durable's temp files. */
const TEMP_DIR = "/.tmp";
/** pi-durable's bound on a command's timeout. */
const MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/** How long an aborted command may take to stop before its worker is replaced. */
const ABORT_GRACE_MS = 2000;
/** Bytes read at a time when scanning a file for lines. */
const SCAN_CHUNK = 1024 * 1024;

const FILE_CODES: Record<string, FileErrorCode> = { not_found: "not_found", is_directory: "is_directory", not_directory: "not_directory", invalid: "invalid", exists: "invalid" };

/** "/a/../b/./c" as "/b/c"; ".." stops at the folder's root. */
export function normalizePath(path: string): string {
	const parts: string[] = [];
	for (const part of path.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") parts.pop();
		else parts.push(part);
	}
	return `/${parts.join("/")}`;
}

const relative = (absolute: string) => normalizePath(absolute).slice(1);
const nameOf = (absolute: string) => absolute.slice(absolute.lastIndexOf("/") + 1);

export function fromBase64(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

export function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	return btoa(binary);
}

/** The plugin's rejection as a FileError. */
function fileError(error: unknown, path?: string): FileError {
	const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
	const message = error instanceof Error ? error.message : String(error);
	return new FileError(typeof code === "string" ? (FILE_CODES[code] ?? "unknown") : "unknown", message, path);
}

const aborted = (context: Context, path?: string) => (context.abortSignal?.aborted ? err<never, FileError>(new FileError("aborted", "Aborted", path)) : undefined);

async function attempt<T>(context: Context, path: string | undefined, run: () => Promise<T>): Promise<Result<T, FileError>> {
	const stop = aborted(context, path);
	if (stop) return stop;
	try {
		return ok(await run());
	} catch (error) {
		return err(fileError(error, path));
	}
}

const infoOf = (absolute: string, info: BotFileInfo): FileInfo => ({ name: nameOf(absolute), path: absolute, kind: info.kind, size: info.size, mtimeMs: info.mtimeMs });

/** Text as decoding the bytes would give it: a leading byte-order mark dropped. */
const withoutBom = (text: string) => (text.startsWith("\uFEFF") ? text.slice(1) : text);

/** One file operation from the bash worker, on the bot's folder. */
async function serveFs(bot: string, request: FsOp): Promise<FsValue> {
	switch (request.op) {
		case "stat": {
			const info = await BotFiles.stat({ bot, path: request.path });
			return { kind: info.kind, size: info.size, mtimeMs: info.mtimeMs };
		}
		case "list":
			return (await BotFiles.list({ bot, path: request.path })).entries.map((entry) => ({ name: entry.name, kind: entry.kind }));
		case "readText":
			return withoutBom((await BotFiles.read({ bot, path: request.path, text: true })).text ?? "");
		case "readBytes":
			return fromBase64((await BotFiles.read({ bot, path: request.path })).data ?? "");
		case "write":
			await BotFiles.write({ bot, path: request.path, append: request.append, ...(typeof request.content === "string" ? { text: request.content } : { data: toBase64(request.content) }) });
			return null;
		case "mkdir":
			await BotFiles.mkdir({ bot, path: request.path, recursive: request.recursive });
			return null;
		case "remove":
			await BotFiles.remove({ bot, path: request.path, recursive: request.recursive, force: request.force });
			return null;
		case "rename":
			await BotFiles.rename({ bot, from: request.from, to: request.to });
			return null;
	}
}

type Finished = { type: "done"; stdout: string; stderr: string; exitCode: number } | { type: "failed"; message: string };

/** The bash worker, shared by every bot's folder; replaced when a command will not stop. */
class Shell {
	#worker: Worker | undefined;
	#nextExec = 0;
	readonly #running = new Map<number, (finished: Finished) => void>();

	#start(): Worker {
		if (this.#worker) return this.#worker;
		const worker = new Worker(new URL("./shell-worker.ts", import.meta.url), { type: "module" });
		worker.addEventListener("message", (event: MessageEvent<FromWorker>) => {
			const message = event.data;
			if (message.type === "fs") {
				const reply = (data: ToWorker) => worker.postMessage(data);
				serveFs(message.bot, message.request).then(
					(value) => reply({ type: "fs-reply", call: message.call, ok: true, value }),
					(error: unknown) => {
						const failure = fileError(error);
						const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
						reply({ type: "fs-reply", call: message.call, ok: false, code: typeof code === "string" ? code : failure.code, message: failure.message });
					},
				);
				return;
			}
			const settle = this.#running.get(message.exec);
			this.#running.delete(message.exec);
			settle?.(message.type === "done" ? { type: "done", stdout: message.stdout, stderr: message.stderr, exitCode: message.exitCode } : { type: "failed", message: message.message });
		});
		worker.addEventListener("error", (event) => this.#fail(`bash stopped: ${event.message}`));
		this.#worker = worker;
		return worker;
	}

	/** End the worker and every command still in it. */
	#fail(message: string): void {
		this.#worker?.terminate();
		this.#worker = undefined;
		for (const settle of this.#running.values()) settle({ type: "failed", message });
		this.#running.clear();
	}

	/** Run a command; settles with "aborted" when the signal fires or the timeout passes, killing the worker if it must. */
	run(bot: string, command: string, cwd: string, env: Record<string, string>, timeoutMs: number | undefined, signal: AbortSignal | undefined): Promise<Finished | { type: "aborted" } | { type: "timeout" }> {
		const worker = this.#start();
		const exec = ++this.#nextExec;
		return new Promise((resolve) => {
			let stopping: ReturnType<typeof setTimeout> | undefined;
			const stop = (why: "aborted" | "timeout") => {
				worker.postMessage({ type: "abort", exec } satisfies ToWorker);
				// just-bash stops at the next statement; a command stuck in one long builtin takes its worker with it.
				stopping = setTimeout(() => this.#fail(`bash did not stop: ${why}`), ABORT_GRACE_MS);
				outcome = why;
			};
			let outcome: "aborted" | "timeout" | undefined;
			const timer = timeoutMs === undefined ? undefined : setTimeout(() => stop("timeout"), timeoutMs);
			const onAbort = () => stop("aborted");
			signal?.addEventListener("abort", onAbort, { once: true });
			this.#running.set(exec, (finished) => {
				clearTimeout(timer);
				clearTimeout(stopping);
				signal?.removeEventListener("abort", onAbort);
				resolve(outcome === "aborted" ? { type: "aborted" } : outcome === "timeout" ? { type: "timeout" } : finished);
			});
			worker.postMessage({ type: "exec", exec, bot, command, cwd, env } satisfies ToWorker);
		});
	}
}

const shell = new Shell();

/** A command as one shell string; an array's words quoted so they reach the command unparsed. */
const commandLine = (command: string | readonly string[]) => (typeof command === "string" ? command : command.map((word) => `'${word.replaceAll("'", `'\\''`)}'`).join(" "));

/** One bot's folder: files through the native plugin, commands through the shared bash worker. */
export class PhoneEnv implements ExecutionEnv {
	readonly id: string;
	cwd = "/";
	readonly #bot: string;

	constructor(bot: string) {
		this.#bot = bot;
		// Each bot's "/" is its own folder, so two bots never name the same file.
		this.id = `phone:${bot}`;
	}

	#path(path: string): string {
		if (path === "~" || path.startsWith("~/")) return normalizePath(path.slice(1));
		return normalizePath(path.startsWith("/") ? path : `${this.cwd}/${path}`);
	}

	#at(path: string) {
		return { bot: this.#bot, path: relative(this.#path(path)) };
	}

	async absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
		return attempt(context, path, async () => this.#path(path));
	}

	async joinPath(parts: string[], context: Context): Promise<Result<string, FileError>> {
		return attempt(context, undefined, async () => this.#path(parts.join("/")));
	}

	async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		return attempt(context, path, async () => withoutBom((await BotFiles.read({ ...this.#at(path), text: true })).text ?? ""));
	}

	async readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
		const text = await this.readTextFile(path, context);
		if (!text.ok) return text;
		const lines = text.value.split("\n");
		if (lines.at(-1) === "") lines.pop();
		return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
	}

	async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		const text = await this.readTextFile(path, context);
		if (!text.ok) return text;
		const lines = text.value.split("\n");
		let next = 0;
		return ok({
			readLine: async () => {
				if (next >= lines.length || (next === lines.length - 1 && lines[next] === "")) return ok(undefined);
				const line = lines[next];
				next++;
				return ok({ text: line, terminated: next < lines.length });
			},
			close: async () => {},
		});
	}

	async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		return attempt(context, path, async () => fromBase64((await BotFiles.read(this.#at(path))).data ?? ""));
	}

	async openBinaryReader(path: string, _options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
		const absolute = this.#path(path);
		const at = this.#at(path);
		const opened = await attempt(context, absolute, () => BotFiles.stat(at));
		if (!opened.ok) return opened;
		if (opened.value.kind === "directory") return err(new FileError("is_directory", `Is a directory: ${absolute}`, absolute));
		const info = infoOf(absolute, opened.value);
		const read = (offset: number, length: number, readContext: Context) =>
			attempt(readContext, absolute, async () => (length <= 0 ? new Uint8Array(0) : fromBase64((await BotFiles.read({ ...at, offset, length })).data ?? "")));
		return ok({
			info: async () => ok(info),
			read,
			scanLines: async (range, scanContext) => {
				let scanner: LineScanner;
				try {
					scanner = new LineScanner(range.startLine, range.endLine);
				} catch {
					return err(new FileError("invalid", "Invalid line range", absolute));
				}
				for (let position = 0; ; position += SCAN_CHUNK) {
					const chunk = await read(position, SCAN_CHUNK, scanContext);
					if (!chunk.ok) return chunk;
					if (chunk.value.length === 0) return ok(scanner.finish());
					scanner.push(chunk.value);
				}
			},
			close: async () => {},
		});
	}

	async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return attempt(context, path, () => BotFiles.write({ ...this.#at(path), ...(typeof content === "string" ? { text: content } : { data: toBase64(content) }) }));
	}

	async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return attempt(context, path, () => BotFiles.write({ ...this.#at(path), append: true, ...(typeof content === "string" ? { text: content } : { data: toBase64(content) }) }));
	}

	async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
		return attempt(context, path, () => BotFiles.truncate({ ...this.#at(path), size }));
	}

	async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
		// Every write is synced by the plugin before it resolves.
		return attempt(context, path, async () => {});
	}

	async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
		return attempt(context, sourcePath, () => BotFiles.rename({ bot: this.#bot, from: relative(this.#path(sourcePath)), to: relative(this.#path(destinationPath)) }));
	}

	async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		const absolute = this.#path(path);
		return attempt(context, absolute, async () => infoOf(absolute, await BotFiles.stat(this.#at(path))));
	}

	async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		const absolute = this.#path(path);
		return attempt(context, absolute, async () =>
			(await BotFiles.list(this.#at(path))).entries.map((entry) => infoOf(absolute === "/" ? `/${entry.name}` : `${absolute}/${entry.name}`, entry)),
		);
	}

	async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
		const listing = await this.listDir(path, context);
		if (!listing.ok) return listing;
		let next = 0;
		return ok({
			next: async (maxEntries: number) => {
				const entries = listing.value.slice(next, next + maxEntries);
				next += entries.length;
				return ok({ entries, done: next >= listing.value.length });
			},
			close: async () => {},
		});
	}

	async watch(): Promise<Result<FileWatcher, FileError>> {
		return err(new FileError("not_supported", "Watching is not supported in the phone's folders"));
	}

	async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		const absolute = this.#path(path);
		return attempt(context, absolute, async () => {
			await BotFiles.stat(this.#at(path));
			return absolute;
		});
	}

	async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		const info = await this.fileInfo(path, context);
		if (info.ok) return ok(true);
		return info.error.code === "not_found" ? ok(false) : info;
	}

	async createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
		return attempt(context, path, () => BotFiles.mkdir({ ...this.#at(path), recursive: Boolean(options?.recursive) }));
	}

	async remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
		return attempt(context, path, () => BotFiles.remove({ ...this.#at(path), recursive: Boolean(options?.recursive), force: Boolean(options?.force) }));
	}

	async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		const absolute = `${TEMP_DIR}/${prefix ?? "tmp-"}${crypto.randomUUID().slice(0, 8)}`;
		return attempt(context, absolute, async () => {
			await BotFiles.mkdir({ bot: this.#bot, path: relative(absolute), recursive: true });
			return absolute;
		});
	}

	async createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
		const absolute = `${TEMP_DIR}/${options?.prefix ?? ""}${crypto.randomUUID()}${options?.suffix ?? ""}`;
		return attempt(context, absolute, async () => {
			await BotFiles.write({ bot: this.#bot, path: relative(absolute), text: "" });
			return absolute;
		});
	}

	async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
		if (context.abortSignal?.aborted) return err(new ExecutionError("aborted", "Aborted"));
		let timeoutMs: number | undefined;
		if (options?.timeout !== undefined) {
			if (!Number.isFinite(options.timeout) || options.timeout <= 0) return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
			timeoutMs = Math.min(options.timeout * 1000, MAX_TIMEOUT_MS);
		}
		const cwd = this.#path(options?.cwd ?? this.cwd);
		const env = {
			HOME: "/",
			USER: "pi",
			// date and friends in the user's own time zone; just-bash defaults to UTC.
			TZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
			...(options?.env ?? {}),
		};
		const finished = await shell.run(this.#bot, commandLine(command), cwd, env, timeoutMs, context.abortSignal);
		if (finished.type === "aborted") return err(new ExecutionError("aborted", "Aborted"));
		if (finished.type === "timeout") return err(new ExecutionError("timeout", `Command timed out after ${options?.timeout} seconds`));
		if (finished.type === "failed") return err(new ExecutionError("unknown", finished.message));
		// just-bash returns its output when the command ends: one chunk per stream.
		if (finished.stdout) options?.onOutput?.(finished.stdout, context, { stream: "stdout" });
		if (finished.stderr) options?.onOutput?.(finished.stderr, context, { stream: "stderr" });
		const spillPath = await this.#spill(finished.stdout + finished.stderr, options, context);
		return ok({ exitCode: finished.exitCode, ...(spillPath ? { spillPath } : {}) });
	}

	/** The whole output in a temporary file when it crosses the thresholds, so the tool can point to it. */
	async #spill(output: string, options: ShellExecOptions | undefined, context: Context): Promise<string | undefined> {
		const spill = options?.spill;
		if (!spill) return undefined;
		const bytes = new TextEncoder().encode(output).length;
		const lines = output.split("\n").length;
		if (bytes <= spill.afterBytes && lines <= spill.afterLines) return undefined;
		const file = await this.createTempFile({ prefix: "pi-output-", suffix: ".log" }, context);
		if (!file.ok) return undefined;
		const written = await this.writeFile(file.value, output, context);
		return written.ok ? file.value : undefined;
	}

	async cleanup(): Promise<void> {}
}

/** A deleted bot's folder and everything in it. */
export async function removePhoneFolder(bot: string): Promise<void> {
	await BotFiles.removeBot({ bot });
}
