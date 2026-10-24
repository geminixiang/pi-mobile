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

type CheckedLine = { text: string; added: boolean; number: number };

export function checkPatch(patch: string): ExecResult {
	if (/^(?:diff --cc |diff --combined |\* Unmerged path |Binary files )/m.test(patch) || patch.includes("\ufffd")) {
		return failure("diff --check cannot inspect combined, unmerged, binary or replacement-character output");
	}
	const errors: string[] = [];
	let path = "";
	let remainingOld = 0;
	let remainingNew = 0;
	let number = 0;
	let lines: CheckedLine[] = [];
	const finish = () => {
		let first = lines.length;
		let added = false;
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i];
			if (!line || !/^[\t \r]*$/.test(line.text)) break;
			first = i;
			added ||= line.added;
		}
		const firstBlank = lines[first];
		if (added && firstBlank) errors.push(`${path}:${firstBlank.number}: new blank line at EOF.\n`);
		lines = [];
	};
	for (const line of patch.split("\n")) {
		if (line.startsWith("diff --git ")) {
			if (!/^diff --git a\/.+ b\/.+$/.test(line) || /[\x00-\x1f\x7f]/.test(line)) return failure("diff --check does not support quoted or control-character paths");
			finish();
			if (remainingOld || remainingNew) return failure("diff --check received an incomplete hunk");
			path = "";
			continue;
		}
		if (remainingOld || remainingNew) {
			if (line.startsWith("\\ No newline at end of file")) continue;
			const prefix = line[0];
			if (prefix !== "+" && prefix !== "-" && prefix !== " ") return failure("diff --check received an unsupported hunk");
			if (prefix !== "+") remainingOld--;
			if (prefix !== "-") {
				remainingNew--;
				const text = line.slice(1);
				const added = prefix === "+";
				lines.push({ text, added, number });
				if (added) {
					const problems: string[] = [];
					if (/^(?:<{7}|={7}|>{7}|\|{7})(?:\s|$)/.test(text)) errors.push(`${path}:${number}: leftover conflict marker\n`);
					if (/[\t \r]$/.test(text)) problems.push("trailing whitespace");
					if (/^[\t ]* \t/.test(text)) problems.push("space before tab in indent");
					if (problems.length) errors.push(`${path}:${number}: ${problems.join(", ")}.\n+${text}\n`);
				}
				number++;
			}
			if (remainingOld < 0 || remainingNew < 0) return failure("diff --check received invalid hunk counts");
			continue;
		}
		if (line.startsWith("+++ ")) {
			if (!line.startsWith("+++ b/") && line !== "+++ /dev/null") return failure("diff --check does not support quoted or custom-prefix paths");
			const rawPath = line.slice(6);
			path = rawPath.endsWith("\t") && rawPath.includes(" ") ? rawPath.slice(0, -1) : rawPath;
			if (/[\x00-\x1f\x7f]/u.test(path)) return failure("diff --check does not support control characters in paths");
		} else if (line.startsWith("@@")) {
			const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
			if (!match || !path) return failure("diff --check received an unsupported hunk header");
			remainingOld = Number(match[2] ?? "1");
			number = Number(match[3]);
			remainingNew = Number(match[4] ?? "1");
		} else if (line !== "" && !/^(?:--- |index |new file mode |deleted file mode |old mode |new mode |similarity index |rename from |rename to |\\ No newline at end of file)/.test(line)) {
			return failure("diff --check received unsupported diff output");
		}
	}
	if (remainingOld || remainingNew) return failure("diff --check received an incomplete hunk");
	finish();
	return { stdout: errors.join(""), stderr: "", exitCode: errors.length ? 2 : 0 };
}

export async function diffCheck(git: Git, args: string[], ctx: Parameters<Git["execute"]>[1]): Promise<ExecResult> {
	let staged = false;
	let paths: string[] = [];
	for (let at = 0; at < args.length; at++) {
		const arg = args[at];
		if (arg === "--check") continue;
		if (arg === "--cached" || arg === "--staged") staged = true;
		else if (arg === "--") {
			paths = args.slice(at + 1);
			break;
		} else return failure(`diff --check: unsupported argument ${arg}; paths must follow --`, 129);
	}
	try {
		const repo = await git.findRepo(ctx);
		if (!repo) return failure("not a git repository");
		if (await repo.fs.exists(`${repo.commonDir}/info/attributes`)) return failure("diff --check does not support info/attributes", 129);
		const attributesFile = await git.execute(["config", "--get", "core.attributesfile"], ctx);
		if (attributesFile.exitCode !== 0 && attributesFile.exitCode !== 1) return attributesFile;
		if (attributesFile.stdout.trim()) return failure("diff --check does not support core.attributesfile", 129);
		const whitespace = await git.execute(["config", "--get", "core.whitespace"], ctx);
		if (whitespace.exitCode !== 0 && whitespace.exitCode !== 1) return whitespace;
		if (whitespace.stdout.trim()) return failure("diff --check does not support configured core.whitespace", 129);
		const result = await git.execute(["diff", "--no-color", "--unified=2147483647", ...(staged ? ["--cached"] : []), ...(paths.length ? ["--", ...paths] : [])], ctx);
		if (result.exitCode !== 0) return result;
		if (repo.workTree) {
			for (const match of result.stdout.matchAll(/^\+\+\+ b\/(.*)$/gm)) {
				const parts = (match[1] ?? "").replace(/\t$/, "").split("/");
				parts.pop();
				for (let depth = 0; depth <= parts.length; depth++) {
					const directory = [repo.workTree, ...parts.slice(0, depth)].join("/");
					if (await repo.fs.exists(`${directory}/.gitattributes`)) return failure("diff --check does not support .gitattributes for changed paths", 129);
				}
			}
		}
		const checked = checkPatch(result.stdout);
		return { ...checked, stderr: result.stderr + checked.stderr };
	} catch (error) {
		return failure(`diff --check: ${messageOf(error)}`);
	}
}
