import type { Git, ExecResult } from "just-git";
import { messageOf } from "../../promise.ts";

const PRETTY_LIMIT = 1024 * 1024;

function failure(message: string, exitCode = 128): ExecResult {
	return { stdout: "", stderr: `git: ${message}\n`, exitCode };
}

function quotePath(path: string): string {
	if (!/[^\x20-\x7e]|["\\]/u.test(path)) return path;
	let quoted = '"';
	for (const byte of new TextEncoder().encode(path)) {
		if (byte === 34 || byte === 92) quoted += `\\${String.fromCharCode(byte)}`;
		else if (byte === 9) quoted += "\\t";
		else if (byte === 10) quoted += "\\n";
		else if (byte >= 32 && byte < 127) quoted += String.fromCharCode(byte);
		else quoted += `\\${byte.toString(8).padStart(3, "0")}`;
	}
	return `${quoted}"`;
}

export async function catFile(git: Git, args: string[], ctx: Parameters<Git["execute"]>[1]): Promise<ExecResult> {
	if (args.length !== 2 || !["-t", "-s", "-p"].includes(args[0] ?? "") || !args[1] || args[1].startsWith("-")) {
		return failure("usage: git cat-file (-t | -s | -p) <object>; other forms are unsupported", 129);
	}
	try {
		const repo = await git.findRepo(ctx);
		if (!repo) return failure("not a git repository");
		const { revParse, readTree } = await import("just-git/repo");
		const hash = await revParse(repo, args[1]);
		if (!hash) return failure(`not a valid object name: ${args[1]}`);
		const object = await repo.objectStore.read(hash);
		if (args[0] === "-t") return { stdout: `${object.type}\n`, stderr: "", exitCode: 0 };
		if (args[0] === "-s") return { stdout: `${object.content.byteLength}\n`, stderr: "", exitCode: 0 };
		if (object.content.byteLength > PRETTY_LIMIT) return failure("cat-file -p exceeds the 1 MiB text output limit");
		let stdout: string;
		if (object.type === "tree") {
			const entries = await readTree(repo, hash);
			if (entries.some((entry) => /[\u0000\ufffd]/u.test(entry.name))) return failure("cat-file -p does not support undecodable tree names");
			stdout = entries.map((entry) => {
				const type = entry.mode === "160000" ? "commit" : Number.parseInt(entry.mode, 8) === 0o40000 ? "tree" : "blob";
				return `${entry.mode.padStart(6, "0")} ${type} ${entry.hash}\t${quotePath(entry.name)}\n`;
			}).join("");
		} else {
			if (object.content.includes(0)) return failure("cat-file -p does not support binary output (NUL)");
			stdout = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(object.content);
		}
		return { stdout, stderr: "", exitCode: 0 };
	} catch (error) {
		return failure(`cat-file: ${messageOf(error)}`);
	}
}
