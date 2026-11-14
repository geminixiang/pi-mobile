import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import { type FileContent, isHtml, type Workspace } from "../agent/sandbox/workspace.ts";
import { appFile } from "../agent/tools/apps.ts";
import { Apps } from "../plugins/apps.ts";
import { OpenOutsideIcon, ShareIcon } from "./icons.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { markdownComponents, remarkPlugins } from "./markdown.tsx";
import { codeOf, messageOf } from "../promise.ts";
import { formatBytes } from "../encoding.ts";
import { BackButton } from "./BackButton.tsx";
import { Tabs } from "./Segmented.tsx";

const HTML_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:">`;

export function withCsp(html: string): string {
	const head = /<head(\s[^>]*)?>/i.exec(html);
	return head ? `${html.slice(0, head.index + head[0].length)}${HTML_CSP}${html.slice(head.index + head[0].length)}` : `${HTML_CSP}${html}`;
}

export const htmlPreviewIsolated = (): boolean => typeof Reflect.get(window, "androidBridge")?.addEventListener === "function" || !("androidBridge" in window);

type LineMarks = { changed: ReadonlySet<number>; picked: string | undefined; onPick: (line: string) => void };

export function CodeLines({ text, marks }: { text: string; marks?: LineMarks }) {
	const trimmed = text.replace(/\n$/, "");
	const lines = trimmed.split("\n");
	return (
		<div className="code-view">
			<pre className="code-gutter" aria-hidden="true">
				{lines.map((_, index) => index + 1).join("\n")}
			</pre>
			{marks ? (
				<pre className="code-text">
					{lines.map((line, index) => (
						<span key={index} className={`code-line${marks.changed.has(index) ? " changed" : ""}${marks.picked === line ? " picked" : ""}`} onClick={() => marks.onPick(line)}>
							{line || " "}
						</span>
					))}
				</pre>
			) : (
				<pre className="code-text">{trimmed}</pre>
			)}
		</div>
	);
}

export type Handed = "open" | "share";

export async function handFile(workspace: Workspace, path: string, how: Handed): Promise<void> {
	const file = appFile(path.split("/").at(-1) ?? "", await workspace.bytes(path));
	if (how === "open") await Apps.openFile(file);
	else await Apps.share({ title: file.fileName, ...file });
}

export const handProblem = (failure: unknown): string => (codeOf(failure) === "NO_APP" ? "手機上沒有能開這種檔案的 app" : messageOf(failure));

type ViewerFrame = { kind: "page"; onClose: () => void };

export function FileViewer({ workspace, path, frame }: { workspace: Workspace; path: string; frame: ViewerFrame }) {
	const [content, setContent] = useState<FileContent>();
	const [error, setError] = useState("");
	const [mode, setMode] = useState<"preview" | "source">("preview");
	const [opening, setOpening] = useState(false);
	const [sharing, setSharing] = useState(false);
	const name = path.split("/").at(-1) ?? "";
	const markdown = /\.(md|markdown)$/i.test(name);
	const html = isHtml(name) && htmlPreviewIsolated();
	const previewable = markdown || html;
	const handOff = (setBusy: (busy: boolean) => void, how: Handed) => {
		setBusy(true);
		void handFile(workspace, path, how)
			.catch((failure: unknown) => setError(handProblem(failure)))
			.finally(() => setBusy(false));
	};

	useEffect(() => {
		let live = true;
		let url: string | undefined;
		setContent(undefined);
		setError("");
		setMode("preview");
		workspace.read(path).then(
			(value) => {
				if (value.kind === "image") url = value.url;
				if (live) setContent(value);
			},
			(failure: unknown) => live && setError(messageOf(failure)),
		);
		return () => {
			live = false;
			if (url) URL.revokeObjectURL(url);
		};
	}, [workspace, path]);

	const openOutside = () => handOff(setOpening, "open");
	const share = () => handOff(setSharing, "share");

	return (
		<div className="screen">
			<header className="bar">
					<BackButton onClick={frame.onClose} />
					<div className="bar-center static">
						<span className="bar-title">{name}</span>
						<span className="bar-model">{path}</span>
					</div>
					{content?.kind === "text" && !html ? (
						<CopyButton text={content.text} className="icon-button" size={18} />
					) : content && content.kind !== "text" ? (
						<button
							type="button"
							className="icon-button"
							aria-label="用其他 app 開啟"
							disabled={opening}
							onClick={openOutside}
						>
							<OpenOutsideIcon />
						</button>
					) : null}
					{content ? (
						<button type="button" className="icon-button" aria-label="分享" disabled={sharing} onClick={share}>
							<ShareIcon />
						</button>
					) : null}
				</header>
			{previewable && content?.kind === "text" ? (
				<Tabs
					options={[
						["preview", "預覽"],
						["source", "原始碼"],
					]}
					value={mode}
					onChange={setMode}
				/>
			) : null}
			<div className="viewer">
				{error ? <div className="banner error">{error}</div> : null}
				{!content && !error ? <div className="ws-loading">讀取中</div> : null}
				{content?.kind === "binary" ? <div className="ws-empty">二進位檔案，無法顯示</div> : null}
				{content?.kind === "image" ? <img className="viewer-image" src={content.url} alt={name} /> : null}
				{content?.kind === "text" && markdown && mode === "preview" ? (
					<div className="answer viewer-markdown">
						<div className="markdown">
							<Markdown remarkPlugins={remarkPlugins} components={markdownComponents} skipHtml>
								{content.text}
							</Markdown>
						</div>
					</div>
				) : null}
				{content?.kind === "text" && html && mode === "preview" ? (
					content.truncated ? <div className="ws-empty">超過 {formatBytes(content.limit)}，無法預覽</div> : <iframe className="viewer-html" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={withCsp(content.text)} title="預覽" />
				) : null}
				{content?.kind === "text" && !(previewable && mode === "preview") ? <CodeLines text={content.text} /> : null}
				{content?.kind === "text" && content.truncated && !(html && mode === "preview") ? <div className="note">只顯示前 {formatBytes(content.limit)}</div> : null}
			</div>
		</div>
	);
}
