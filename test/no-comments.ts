import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseSync } from "rolldown/utils";

export type Comment = { start: number; end: number };

const GENERATED = new Set(["android/capacitor.settings.gradle", "android/app/capacitor.build.gradle", "android/gradlew", "android/gradlew.bat"]);
const SCRIPT_FILE = /\.(ts|tsx|js)$/;
const C_LIKE_FILE = /\.(java|go|gradle|css)$/;
const HASH_FILE = /(\.(sh|py|yml|yaml|pro|properties)|Dockerfile)$/;
const MARKUP_FILE = /\.(html|xml)$/;
const GO_DIRECTIVE = /^\/\/go:/;
const TRIPLE_SLASH_REFERENCE = /^\/\/\/ <reference /;

function scriptComments(file: string, source: string): Comment[] {
	return parseSync(file, source)
		.comments.filter((comment) => !TRIPLE_SLASH_REFERENCE.test(source.slice(comment.start, comment.end)))
		.map(({ start, end }) => ({ start, end }));
}

function endOfQuoted(source: string, from: number, quote: string, escapes: boolean): number {
	let cursor = from + 1;
	while (cursor < source.length && source[cursor] !== quote && source[cursor] !== "\n") cursor += escapes && source[cursor] === "\\" ? 2 : 1;
	return cursor + 1;
}

function cLikeComments(file: string, source: string): Comment[] {
	const comments: Comment[] = [];
	const lineComments = !file.endsWith(".css");
	const rawStrings = file.endsWith(".go");
	let index = 0;
	while (index < source.length) {
		const char = source[index];
		const next = source[index + 1];
		if (source.startsWith('"""', index)) {
			const end = source.indexOf('"""', index + 3);
			index = end === -1 ? source.length : end + 3;
		} else if (char === '"' || char === "'") {
			index = endOfQuoted(source, index, char, true);
		} else if (char === "`" && rawStrings) {
			const end = source.indexOf("`", index + 1);
			index = end === -1 ? source.length : end + 1;
		} else if (char === "/" && next === "/" && lineComments) {
			const newline = source.indexOf("\n", index);
			const end = newline === -1 ? source.length : newline;
			const isUrl = source[index - 1] === ":";
			if (!isUrl && !GO_DIRECTIVE.test(source.slice(index, end))) comments.push({ start: index, end });
			index = end;
		} else if (char === "/" && next === "*") {
			const close = source.indexOf("*/", index + 2);
			const end = close === -1 ? source.length : close + 2;
			comments.push({ start: index, end });
			index = end;
		} else {
			index += 1;
		}
	}
	return comments;
}

function withoutQuoted(line: string): string {
	return line.replace(/(["'])(?:\\.|(?!\1).)*\1/g, (quoted) => " ".repeat(quoted.length));
}

function hashComments(source: string): Comment[] {
	const comments: Comment[] = [];
	let offset = 0;
	source.split("\n").forEach((line, at) => {
		const isShebang = at === 0 && line.startsWith("#!");
		const bare = withoutQuoted(line);
		const column = /^\s*#/.test(bare) ? bare.indexOf("#") : bare.search(/\s#(\s|$)/) + 1;
		const isComment = /^\s*#/.test(bare) || column > 0;
		if (isComment && !isShebang) comments.push({ start: offset + column, end: offset + line.length });
		offset += line.length + 1;
	});
	return comments;
}

function markupComments(source: string): Comment[] {
	return [...source.matchAll(/<!--[\s\S]*?-->/g)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
}

export function commentsIn(file: string, source: string): Comment[] {
	if (SCRIPT_FILE.test(file)) return scriptComments(file, source);
	if (C_LIKE_FILE.test(file)) return cLikeComments(file, source);
	if (HASH_FILE.test(file)) return hashComments(source);
	if (MARKUP_FILE.test(file)) return markupComments(source);
	return [];
}

export function checkedFiles(): string[] {
	return execFileSync("git", ["ls-files"], { encoding: "utf8" })
		.split("\n")
		.filter((file) => file && !GENERATED.has(file) && !file.startsWith("android/app/src/main/res/"));
}

if (import.meta.main) {
	const findings = checkedFiles().flatMap((file) => {
		const source = readFileSync(file, "utf8");
		return commentsIn(file, source).map(({ start }) => ({
			file,
			line: source.slice(0, start).split("\n").length,
			text: source.slice(start, source.indexOf("\n", start) === -1 ? undefined : source.indexOf("\n", start)),
		}));
	});
	const files = new Set(findings.map((finding) => finding.file));
	if (findings.length === 0) {
		console.log("no-comments: no comments in the code");
	} else {
		for (const finding of findings) console.error(`${finding.file}:${finding.line}: ${finding.text}`);
		console.error(`no-comments: ${findings.length} comments in ${files.size} files`);
		process.exit(1);
	}
}
