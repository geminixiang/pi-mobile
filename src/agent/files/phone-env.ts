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
import { BotFiles, type BotFileInfo } from "../../plugins/bot-files.ts";
import { type FromWorker, type FsOp, type FsValue, normalizePath, resolvePath, TEMP_FOLDER, type ToWorker } from "./protocol.ts";
import { type FolderNetwork, sendFromFolder } from "./folder-network.ts";
import { codeOf, messageOf, untilFailure } from "../../promise.ts";
import { fromBase64, toBase64 } from "../../encoding.ts";
import { shellQuote } from "../../shell.ts";
import { HOUR } from "../tools/common.ts";

const TEMP_DIR = "/tmp";
const MAX_TIMEOUT_MS = 2 * HOUR;
const ABORT_GRACE_MS = 2000;
const SCAN_CHUNK = 1024 * 1024;

const FILE_CODES: Record<string, FileErrorCode> = { not_found: "not_found", is_directory: "is_directory", not_directory: "not_directory", invalid: "invalid", exists: "invalid" };

function relative(absolute: string): string {
	const path = normalizePath(absolute);
	const inTemp = path === TEMP_DIR || path.startsWith(`${TEMP_DIR}/`);
	return inTemp ? `${TEMP_FOLDER}${path.slice(TEMP_DIR.length)}` : path.slice(1);
}
const nameOf = (absolute: string) => absolute.slice(absolute.lastIndexOf("/") + 1);

function fileError(error: unknown, path?: string): FileError {
	const code = codeOf(error);
	return new FileError(code ? (FILE_CODES[code] ?? "unknown") : "unknown", messageOf(error), path);
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

const withoutBom = (text: string) => (text.startsWith("\uFEFF") ? text.slice(1) : text);

type At = { bot: string; path: string };

const readText = async (at: At) => withoutBom((await BotFiles.read({ ...at, text: true })).text ?? "");

const readBytes = async (at: At & { offset?: number; length?: number }) => fromBase64((await BotFiles.read(at)).data ?? "");

const writeContent = (at: At, content: string | Uint8Array, append: boolean) =>
	BotFiles.write({ ...at, append, ...(typeof content === "string" ? { text: content } : { data: toBase64(content) }) });

async function serveFs(bot: string, request: FsOp): Promise<FsValue> {
	switch (request.op) {
		case "stat": {
			const info = await BotFiles.stat({ bot, path: request.path });
			return { kind: info.kind, size: info.size, mtimeMs: info.mtimeMs, executable: info.executable };
		}
		case "create":
			await BotFiles.create({ bot, path: request.path, directory: request.directory });
			return null;
		case "chmod":
			await BotFiles.chmod({ bot, path: request.path, mode: request.mode });
			return null;
		case "exists":
			return (await BotFiles.exists({ bot, path: request.path })).exists;
		case "list":
			return (await BotFiles.list({ bot, path: request.path })).entries.map((entry) => ({ name: entry.name, kind: entry.kind }));
		case "readText":
			return readText({ bot, path: request.path });
		case "readBytes":
			return readBytes({ bot, path: request.path });
		case "write":
			await writeContent({ bot, path: request.path }, request.content, request.append);
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

function fits(output: string, limit: { afterBytes: number; afterLines: number }): boolean {
	if (output.length > limit.afterBytes) return false;
	let lines = 1;
	for (let at = output.indexOf("\n"); at >= 0; at = output.indexOf("\n", at + 1)) {
		lines++;
		if (lines > limit.afterLines) return false;
	}
	return output.length * 3 <= limit.afterBytes || new TextEncoder().encode(output).length <= limit.afterBytes;
}

type Finished = { type: "done"; stdout: string; stderr: string; exitCode: number } | { type: "failed"; message: string };

class Shell {
	#worker: Worker | undefined;
	#nextExec = 0;
	readonly #running = new Map<number, (finished: Finished) => void>();
	readonly #networks = new Map<number, FolderNetwork>();

	#start(): Worker {
		if (this.#worker) return this.#worker;
		const worker = new Worker(new URL("./shell-worker.ts", import.meta.url), { type: "module" });
		worker.addEventListener("message", (event: MessageEvent<FromWorker>) => {
			const message = event.data;
			if (message.type === "fs") {
				const reply = (data: ToWorker) => worker.postMessage(data);
				serveFs(message.bot, message.request).then(
					(value) => reply({ type: "fs-reply", call: message.call, ok: true, value }),
					(error: unknown) => reply({ type: "fs-reply", call: message.call, ok: false, code: codeOf(error) ?? "unknown", message: messageOf(error) }),
				);
				return;
			}
			if (message.type === "http") {
				const network = this.#networks.get(message.exec);
				const failed = (text: string) => worker.postMessage({ type: "http-reply", call: message.call, ok: false, message: text } satisfies ToWorker);
				if (!network) {
					failed("network: the command that asked has finished");
					return;
				}
				sendFromFolder(message.request, network).then(
					(response) => worker.postMessage({ type: "http-reply", call: message.call, ok: true, response } satisfies ToWorker, [response.body.buffer]),
					(error: unknown) => failed(messageOf(error)),
				);
				return;
			}
			const settle = this.#running.get(message.exec);
			this.#running.delete(message.exec);
			this.#networks.delete(message.exec);
			settle?.(message.type === "done" ? { type: "done", stdout: message.stdout, stderr: message.stderr, exitCode: message.exitCode } : { type: "failed", message: message.message });
		});
		worker.addEventListener("error", (event) => this.#fail(`bash stopped: ${event.message}`));
		this.#worker = worker;
		return worker;
	}

	#fail(message: string): void {
		this.#worker?.terminate();
		this.#worker = undefined;
		for (const settle of this.#running.values()) settle({ type: "failed", message });
		this.#running.clear();
		this.#networks.clear();
	}

	run(bot: string, command: string, cwd: string, env: Record<string, string>, network: FolderNetwork, timeoutMs: number | undefined, signal: AbortSignal | undefined): Promise<Finished | { type: "aborted" } | { type: "timeout" }> {
		const worker = this.#start();
		const exec = ++this.#nextExec;
		return new Promise((resolve) => {
			let stopping: ReturnType<typeof setTimeout> | undefined;
			const stop = (why: "aborted" | "timeout") => {
				worker.postMessage({ type: "abort", exec } satisfies ToWorker);
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
			this.#networks.set(exec, network);
			worker.postMessage({ type: "exec", exec, bot, command, cwd, env } satisfies ToWorker);
		});
	}
}

const shell = new Shell();

const commandLine = (command: string | readonly string[]) => (typeof command === "string" ? command : command.map(shellQuote).join(" "));

export class PhoneEnv implements ExecutionEnv {
	readonly id: string;
	cwd = "/";
	readonly #bot: string;
	readonly #network: FolderNetwork;
	readonly #ensureTemp = untilFailure(() => BotFiles.mkdir({ bot: this.#bot, path: TEMP_FOLDER, recursive: true }));

	constructor(folder: string, network: FolderNetwork) {
		this.#bot = folder;
		this.#network = network;
		this.id = `phone:${folder}`;
	}

	#path(path: string): string {
		if (path === "~" || path.startsWith("~/")) return normalizePath(path.slice(1));
		return resolvePath(this.cwd, path);
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
		return attempt(context, path, () => readText(this.#at(path)));
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
		return attempt(context, path, () => readBytes(this.#at(path)));
	}

	async openBinaryReader(path: string, _options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
		const absolute = this.#path(path);
		const at = this.#at(path);
		const opened = await attempt(context, absolute, () => BotFiles.stat(at));
		if (!opened.ok) return opened;
		if (opened.value.kind === "directory") return err(new FileError("is_directory", `Is a directory: ${absolute}`, absolute));
		const info = infoOf(absolute, opened.value);
		const read = (offset: number, length: number, readContext: Context) =>
			attempt(readContext, absolute, async () => (length <= 0 ? new Uint8Array(0) : readBytes({ ...at, offset, length })));
		return ok({
			info: async () => ok(info),
			read,
			scanLines: async (range, scanContext) => {
				const endLine = range.endLine ?? Number.POSITIVE_INFINITY;
				const isValidRange = Number.isSafeInteger(range.startLine) && range.startLine >= 0 && endLine > range.startLine && (endLine === Number.POSITIVE_INFINITY || Number.isSafeInteger(endLine));
				if (!isValidRange) return err(new FileError("invalid", "Invalid line range", absolute));
				const scanner = new LineScanner(range.startLine, range.endLine);
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
		return attempt(context, path, () => writeContent(this.#at(path), content, false));
	}

	async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return attempt(context, path, () => writeContent(this.#at(path), content, true));
	}

	async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
		return attempt(context, path, () => BotFiles.truncate({ ...this.#at(path), size }));
	}

	async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
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
			await this.#ensureTemp();
			await BotFiles.mkdir({ bot: this.#bot, path: relative(absolute), recursive: true });
			return absolute;
		});
	}

	async createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
		const absolute = `${TEMP_DIR}/${options?.prefix ?? ""}${crypto.randomUUID()}${options?.suffix ?? ""}`;
		return attempt(context, absolute, async () => {
			await this.#ensureTemp();
			await BotFiles.write({ bot: this.#bot, path: relative(absolute), text: "" });
			return absolute;
		});
	}

	async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
		if (context.abortSignal?.aborted) return err(new ExecutionError("aborted", "Aborted"));
		const timeout = options?.timeout;
		if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
		const timeoutMs = timeout === undefined ? undefined : Math.min(timeout * 1000, MAX_TIMEOUT_MS);
		const cwd = this.#path(options?.cwd ?? this.cwd);
		const prepared = await Promise.all([this.#ensureTemp(), BotFiles.stat({ bot: this.#bot, path: relative(cwd) })]).then(
			([, info]) => (info.kind === "directory" ? undefined : `Not a directory: ${cwd}`),
			(error: unknown) => `Cannot run in ${cwd}: ${messageOf(error)}`,
		);
		if (prepared) return err(new ExecutionError("spawn_error", prepared));
		const env = {
			HOME: "/",
			USER: "pi",
			TMPDIR: TEMP_DIR,
			TZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
			...(options?.env ?? {}),
		};
		const finished = await shell.run(this.#bot, commandLine(command), cwd, env, this.#network, timeoutMs, context.abortSignal);
		if (finished.type === "aborted") return err(new ExecutionError("aborted", "Aborted"));
		if (finished.type === "timeout") return err(new ExecutionError("timeout", `Command timed out after ${options?.timeout} seconds`));
		if (finished.type === "failed") return err(new ExecutionError("unknown", finished.message));
		if (finished.stdout) options?.onOutput?.(finished.stdout, context, { stream: "stdout" });
		if (finished.stderr) options?.onOutput?.(finished.stderr, context, { stream: "stderr" });
		const spillPath = await this.#spill(finished.stdout + finished.stderr, options, context);
		return ok({ exitCode: finished.exitCode, ...(spillPath ? { spillPath } : {}) });
	}

	async #spill(output: string, options: ShellExecOptions | undefined, context: Context): Promise<string | undefined> {
		const spill = options?.spill;
		if (!spill) return undefined;
		if (fits(output, spill)) return undefined;
		const file = await this.createTempFile({ prefix: "pi-output-", suffix: ".log" }, context);
		if (!file.ok) return undefined;
		const written = await this.writeFile(file.value, output, context);
		return written.ok ? file.value : undefined;
	}

	async download(url: string, path: string, context: Context): Promise<Result<{ path: string; size: number; contentType: string; url: string }, FileError>> {
		const absolute = this.#path(path);
		return attempt(context, absolute, async () => ({ path: absolute, ...(await BotFiles.download({ ...this.#at(path), url })) }));
	}

	async cleanup(): Promise<void> {}
}

export async function removePhoneFolder(bot: string): Promise<void> {
	await BotFiles.removeBot({ bot });
}

export async function phoneFolderOwners(): Promise<string[]> {
	return (await BotFiles.listBots()).ids;
}
