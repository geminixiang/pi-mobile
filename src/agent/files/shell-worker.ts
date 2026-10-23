import "../../shims/buffer-global.ts";
import { Bash, type CommandName, getCommandNames, type IFileSystem, InMemoryFs, MountableFs } from "just-bash/browser";
import type { FromWorker, FsOp, FsValue, ToWorker } from "./protocol.ts";
import { messageOf } from "../../promise.ts";

const UNAVAILABLE = new Set(["tar", "yq", "xan", "sqlite3", "python3", "python", "html-to-markdown"]);
const COMMANDS = getCommandNames().filter((name): name is CommandName => !UNAVAILABLE.has(name));

const post = (message: FromWorker) => postMessage(message);
const pending = new Map<number, { resolve: (value: FsValue) => void; reject: (error: Error) => void }>();
let nextCall = 0;
const running = new Map<number, AbortController>();

const NODE_CODES: Record<string, string> = { not_found: "ENOENT", is_directory: "EISDIR", not_directory: "ENOTDIR", exists: "EEXIST", invalid: "EINVAL" };

function ask(bot: string, request: FsOp): Promise<FsValue> {
	return new Promise((resolve, reject) => {
		const call = ++nextCall;
		pending.set(call, { resolve, reject });
		post({ type: "fs", call, bot, request });
	});
}

function normalize(path: string): string {
	const parts: string[] = [];
	for (const part of path.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") parts.pop();
		else parts.push(part);
	}
	return `/${parts.join("/")}`;
}

const TEMP_FOLDER = ".tmp";
const DEVICE_READ_BYTES = 64 * 1024;
const DATA_SCALE_LIMIT = 10_000_000;
const LIMITS = {
	maxCommandCount: DATA_SCALE_LIMIT,
	maxLoopIterations: DATA_SCALE_LIMIT,
	maxAwkIterations: DATA_SCALE_LIMIT,
	maxSedIterations: DATA_SCALE_LIMIT,
	maxJqIterations: DATA_SCALE_LIMIT,
	maxBraceExpansionResults: DATA_SCALE_LIMIT,
};

function isStat(value: FsValue): value is { kind: "file" | "directory"; size: number; mtimeMs: number; executable: boolean } {
	return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array);
}

function textOf(content: string | Uint8Array, encoding: unknown): string | Uint8Array {
	if (typeof content !== "string" || encoding === undefined || encoding === "utf8" || encoding === "utf-8") return content;
	const name = typeof encoding === "string" ? encoding : typeof encoding === "object" && encoding !== null ? Reflect.get(encoding, "encoding") : undefined;
	if (name === "base64") return Uint8Array.from(atob(content), (char) => char.charCodeAt(0));
	if (name === "binary" || name === "latin1") return Uint8Array.from(content, (char) => char.charCodeAt(0) & 0xff);
	return content;
}

function folderFs(bot: string, root = ""): IFileSystem {
	const rel = (path: string) => [root, normalize(path).slice(1)].filter(Boolean).join("/");
	const stat = async (path: string) => {
		const value = await ask(bot, { op: "stat", path: rel(path) });
		if (!isStat(value)) throw new Error(`EIO: bad stat, '${path}'`);
		const mode = value.kind === "directory" || value.executable ? 0o755 : 0o644;
		return { isFile: value.kind === "file", isDirectory: value.kind === "directory", isSymbolicLink: false, mode, size: value.size, mtime: new Date(value.mtimeMs), identity: `${root}${normalize(path)}` };
	};
	const entries = async (path: string) => {
		const value = await ask(bot, { op: "list", path: rel(path) });
		if (!Array.isArray(value)) throw new Error(`EIO: bad listing, '${path}'`);
		return [...value].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	};
	const readBytes = async (path: string) => {
		const value = await ask(bot, { op: "readBytes", path: rel(path) });
		if (!(value instanceof Uint8Array)) throw new Error(`EIO: bad read, '${path}'`);
		return value;
	};
	const write = async (path: string, content: string | Uint8Array, append: boolean) => {
		await ask(bot, { op: "write", path: rel(path), content, append });
	};
	const exists = async (path: string) => (await ask(bot, { op: "exists", path: rel(path) })) === true;
	const copy = async (from: string, to: string, recursive: boolean): Promise<void> => {
		const info = await stat(from);
		if (info.isFile) return write(to, await readBytes(from), false);
		if (!recursive) throw new Error(`EISDIR: is a directory, cp '${from}'`);
		await ask(bot, { op: "mkdir", path: rel(to), recursive: true });
		for (const entry of await entries(from)) await copy(`${normalize(from)}/${entry.name}`, `${normalize(to)}/${entry.name}`, true);
	};
	const unsupported = (what: string) => async () => {
		throw new Error(`ENOSYS: ${what} is not supported in this folder`);
	};
	return {
		async readFile(path, options) {
			if (options === undefined || options === "utf8" || options === "utf-8" || (typeof options === "object" && (options.encoding === undefined || options.encoding === "utf8" || options.encoding === "utf-8"))) {
				const value = await ask(bot, { op: "readText", path: rel(path) });
				if (typeof value !== "string") throw new Error(`EIO: bad read, '${path}'`);
				return value;
			}
			const bytes = await readBytes(path);
			const name = typeof options === "string" ? options : options?.encoding;
			if (name === "base64") return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
			if (name === "hex") return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
			return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
		},
		readFileBuffer: readBytes,
		writeFile: (path, content, options) => write(path, textOf(content, options), false),
		appendFile: (path, content, options) => write(path, textOf(content, options), true),
		exists,
		stat,
		lstat: stat,
		async mkdir(path, options) {
			await ask(bot, { op: "mkdir", path: rel(path), recursive: Boolean(options?.recursive) });
		},
		async createExclusive(path, options) {
			await ask(bot, { op: "create", path: rel(path), directory: Boolean(options.directory) });
		},
		async readdir(path) {
			return (await entries(path)).map((entry) => entry.name);
		},
		async readdirWithFileTypes(path) {
			return (await entries(path)).map((entry) => ({ name: entry.name, isFile: entry.kind === "file", isDirectory: entry.kind === "directory", isSymbolicLink: false }));
		},
		async rm(path, options) {
			await ask(bot, { op: "remove", path: rel(path), recursive: Boolean(options?.recursive), force: Boolean(options?.force) });
		},
		cp: (from, to, options) => copy(from, to, Boolean(options?.recursive)),
		async mv(from, to) {
			await ask(bot, { op: "rename", from: rel(from), to: rel(to) });
		},
		resolvePath: (base, path) => normalize(path.startsWith("/") ? path : `${base}/${path}`),
		getAllPaths: () => [],
		async realpath(path) {
			await stat(path);
			return normalize(path);
		},
		async chmod(path, mode) {
			await ask(bot, { op: "chmod", path: rel(path), mode });
		},
		async utimes() {},
		symlink: unsupported("symlink"),
		link: unsupported("link"),
		readlink: async (path) => {
			throw new Error(`EINVAL: not a symbolic link, readlink '${path}'`);
		},
	};
}

function readOnly(path: string): never {
	throw new Error(`EROFS: read-only file system, '${path}'`);
}

function deviceFs(): IFileSystem {
	const devices: Record<string, () => Uint8Array> = {
		"/null": () => new Uint8Array(0),
		"/zero": () => new Uint8Array(DEVICE_READ_BYTES),
		"/urandom": () => crypto.getRandomValues(new Uint8Array(DEVICE_READ_BYTES)),
		"/random": () => crypto.getRandomValues(new Uint8Array(DEVICE_READ_BYTES)),
	};
	const device = (path: string) => {
		const read = devices[normalize(path)];
		if (!read) throw new Error(`ENOENT: no such device, '/dev${normalize(path)}'`);
		return read;
	};
	const stat = async (path: string) => {
		const isRoot = normalize(path) === "/";
		if (!isRoot) device(path);
		return { isFile: !isRoot, isDirectory: isRoot, isSymbolicLink: false, mode: isRoot ? 0o755 : 0o666, size: 0, mtime: new Date(0), identity: `/dev${normalize(path)}` };
	};
	const discard = async (path: string) => {
		device(path);
	};
	return {
		readFile: async (path) => new TextDecoder().decode(device(path)()),
		readFileBuffer: async (path) => device(path)(),
		writeFile: discard,
		appendFile: discard,
		exists: async (path) => normalize(path) === "/" || normalize(path) in devices,
		stat,
		lstat: stat,
		mkdir: async (path) => readOnly(path),
		readdir: async () => Object.keys(devices).map((name) => name.slice(1)),
		rm: async (path) => readOnly(path),
		cp: async (_from, to) => readOnly(to),
		mv: async (from) => readOnly(from),
		resolvePath: (base, path) => normalize(path.startsWith("/") ? path : `${base}/${path}`),
		getAllPaths: () => [],
		realpath: async (path) => normalize(path),
		chmod: async (path) => readOnly(path),
		utimes: async () => undefined,
		symlink: async (_target, path) => readOnly(path),
		link: async (_target, path) => readOnly(path),
		readlink: async (path) => {
			throw new Error(`EINVAL: not a symbolic link, readlink '${path}'`);
		},
	};
}

const COMMAND_STUBS = Object.fromEntries(COMMANDS.map((name) => [`/${name}`, { content: "", mode: 0o755 }]));

function botFs(bot: string): IFileSystem {
	return new MountableFs({
		base: folderFs(bot),
		mounts: [
			{ mountPoint: "/tmp", filesystem: folderFs(bot, TEMP_FOLDER) },
			{ mountPoint: "/dev", filesystem: deviceFs() },
			{ mountPoint: "/bin", filesystem: new InMemoryFs(COMMAND_STUBS) },
			{ mountPoint: "/usr/bin", filesystem: new InMemoryFs(COMMAND_STUBS) },
		],
	});
}

addEventListener("message", (event: MessageEvent<ToWorker>) => {
	const message = event.data;
	if (message.type === "fs-reply") {
		const waiter = pending.get(message.call);
		pending.delete(message.call);
		if (!waiter) return;
		if (message.ok) waiter.resolve(message.value);
		else waiter.reject(Object.assign(new Error(`${NODE_CODES[message.code] ?? "EIO"}: ${message.message}`), { code: NODE_CODES[message.code] ?? "EIO" }));
		return;
	}
	if (message.type === "abort") {
		running.get(message.exec)?.abort();
		return;
	}
	const controller = new AbortController();
	running.set(message.exec, controller);
	const bash = new Bash({ fs: botFs(message.bot), cwd: message.cwd, env: message.env, commands: COMMANDS, executionLimits: LIMITS });
	bash.exec(message.command, { cwd: message.cwd, signal: controller.signal }).then(
		(result) => post({ type: "done", exec: message.exec, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }),
		(error: unknown) => post({ type: "failed", exec: message.exec, message: messageOf(error) }),
	).finally(() => running.delete(message.exec));
});
