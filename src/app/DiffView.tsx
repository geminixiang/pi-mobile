import { useEffect, useState } from "react";
import { BackIcon } from "./icons.tsx";
import { Layer } from "./Sheet.tsx";

export interface DiffTarget {
	repo: string;
	title: string;
	load: () => Promise<string>;
}

type Line = { kind: "add" | "del" | "ctx" | "hunk" | "note"; text: string; old?: number; new?: number };

interface FileDiff {
	path: string;
	label?: "新檔案" | "已刪除" | "重新命名" | "二進位";
	added: number;
	removed: number;
	lines: Line[];
}

/** Split unified diff text (git diff or git show) into a commit message and per-file hunks. */
function parse(text: string): { message: string[]; files: FileDiff[] } {
	const message: string[] = [];
	const files: FileDiff[] = [];
	let file: FileDiff | undefined;
	let oldLine = 0;
	let newLine = 0;
	let inHunk = false;
	for (const raw of text.split("\n")) {
		if (raw.startsWith("diff --git ") || raw.startsWith("diff --no-index")) {
			const path = / b\/(.+)$/.exec(raw)?.[1] ?? raw.slice(11);
			file = { path, added: 0, removed: 0, lines: [] };
			files.push(file);
			inHunk = false;
			continue;
		}
		if (!file) {
			message.push(raw);
			continue;
		}
		if (raw.startsWith("@@")) {
			const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
			oldLine = Number(match?.[1] ?? 0);
			newLine = Number(match?.[2] ?? 0);
			inHunk = true;
			file.lines.push({ kind: "hunk", text: match?.[3]?.trim() || `第 ${newLine} 行` });
			continue;
		}
		if (!inHunk) {
			if (raw.startsWith("new file mode")) file.label = "新檔案";
			else if (raw.startsWith("deleted file mode")) file.label = "已刪除";
			else if (raw.startsWith("rename to ")) file.label = "重新命名";
			else if (raw.startsWith("Binary files")) file.label = "二進位";
			else if (raw.startsWith("+++ ") && raw !== "+++ /dev/null") file.path = raw.slice(4).replace(/^b\//, "");
			continue;
		}
		if (raw.startsWith("+")) {
			file.added++;
			file.lines.push({ kind: "add", text: raw.slice(1), new: newLine++ });
		} else if (raw.startsWith("-")) {
			file.removed++;
			file.lines.push({ kind: "del", text: raw.slice(1), old: oldLine++ });
		} else if (raw.startsWith("\\")) {
			file.lines.push({ kind: "note", text: raw.slice(2) });
		} else if (raw !== "" || file.lines.length > 0) {
			file.lines.push({ kind: "ctx", text: raw.slice(1), old: oldLine++, new: newLine++ });
		}
	}
	// A trailing newline in the output leaves one empty context line at the end.
	for (const each of files) if (each.lines.at(-1)?.kind === "ctx" && each.lines.at(-1)?.text === "") each.lines.pop();
	return { message: message.join("\n").trim().split("\n"), files };
}

const SIGN = { add: "+", del: "−", ctx: " ", hunk: "", note: "" };

function FileBlock({ file }: { file: FileDiff }) {
	return (
		<section className="diff-file">
			<header className="diff-file-head">
				<span className="file-name">{file.path}</span>
				{file.label ? <span className="diff-label">{file.label}</span> : null}
				<span className="change-counts">
					<b className="plus">+{file.added}</b> <b className="minus">−{file.removed}</b>
				</span>
			</header>
			<div className="diff-body">
				<div className="diff-lines">
					{file.lines.map((line, index) =>
						line.kind === "hunk" ? (
							<div className="diff-hunk" key={index}>
								@@ {line.text}
							</div>
						) : (
							<div className={`diff-line ${line.kind}`} key={index}>
								<span className="diff-no">{line.old ?? ""}</span>
								<span className="diff-no">{line.new ?? ""}</span>
								<span className="diff-sign">{SIGN[line.kind]}</span>
								<span className="diff-text">{line.text}</span>
							</div>
						),
					)}
				</div>
			</div>
		</section>
	);
}

export function DiffView({ target, onClose }: { target: DiffTarget | undefined; onClose: () => void }) {
	const [text, setText] = useState<string>();
	const [error, setError] = useState("");

	useEffect(() => {
		if (!target) return;
		let live = true;
		setText(undefined);
		setError("");
		target.load().then(
			(value) => live && setText(value),
			(failure: unknown) => live && setError(failure instanceof Error ? failure.message : String(failure)),
		);
		return () => {
			live = false;
		};
	}, [target]);

	const parsed = text === undefined ? undefined : parse(text);
	const commit = parsed && parsed.message.length > 1 ? parsed.message : undefined;
	return (
		<Layer open={Boolean(target)} kind="page" onClose={onClose} label="差異">
			<div className="screen">
				<header className="bar">
					<button type="button" className="icon-button" onClick={onClose} aria-label="返回">
						<BackIcon />
					</button>
					<div className="bar-center static">
						<span className="bar-title">{target?.title}</span>
						{parsed ? (
							<span className="bar-model">
								{parsed.files.length} 個檔案 · +{parsed.files.reduce((sum, file) => sum + file.added, 0)} −
								{parsed.files.reduce((sum, file) => sum + file.removed, 0)}
							</span>
						) : null}
					</div>
				</header>
				<div className="viewer">
					{error ? <div className="banner error">{error}</div> : null}
					{!parsed && !error ? <div className="ws-loading">讀取中</div> : null}
					{commit ? (
						<div className="commit-message">
							<div className="commit-meta">
								{commit[0]?.slice(0, 12)} · {commit[1]} · {commit[2]}
							</div>
							<pre>{commit.slice(3).join("\n").trim()}</pre>
						</div>
					) : null}
					{parsed?.files.length === 0 ? <div className="ws-empty">沒有差異</div> : null}
					{parsed?.files.map((file, index) => <FileBlock file={file} key={`${file.path}-${index}`} />)}
				</div>
			</div>
		</Layer>
	);
}
