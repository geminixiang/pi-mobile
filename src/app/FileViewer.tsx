import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import { type FileContent, isHtml, type Workspace } from "../agent/sandbox/workspace.ts";
import { type AppFile, appFile } from "../agent/tools/apps.ts";
import { Apps } from "../plugins/apps.ts";
import { OpenOutsideIcon, ShareIcon } from "./icons.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { markdownComponents, remarkPlugins } from "./Message.tsx";
import { Layer } from "./Sheet.tsx";
import { codeOf, messageOf } from "../promise.ts";
import { BackButton } from "./BackButton.tsx";
import { Tabs } from "./Segmented.tsx";

const HTML_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:">`;

function withCsp(html: string): string {
	const head = /<head(\s[^>]*)?>/i.exec(html);
	return head ? `${html.slice(0, head.index + head[0].length)}${HTML_CSP}${html.slice(head.index + head[0].length)}` : `${HTML_CSP}${html}`;
}

const htmlPreviewIsolated = (): boolean => typeof Reflect.get(window, "androidBridge")?.addEventListener === "function" || !("androidBridge" in window);

function HtmlPreview({ html }: { html: string }) {
	return <iframe className="viewer-html" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={withCsp(html)} title="預覽" />;
}

function CodeLines({ text }: { text: string }) {
	const lines = text.replace(/\n$/, "").split("\n");
	return (
		<div className="code-view">
			<pre className="code-gutter" aria-hidden="true">
				{lines.map((_, index) => index + 1).join("\n")}
			</pre>
			<pre className="code-text">{text.replace(/\n$/, "")}</pre>
		</div>
	);
}

export function FileViewer({ workspace, path, onClose }: { workspace: Workspace; path: string | undefined; onClose: () => void }) {
	const [content, setContent] = useState<FileContent>();
	const [error, setError] = useState("");
	const [mode, setMode] = useState<"preview" | "source">("preview");
	const [opening, setOpening] = useState(false);
	const [sharing, setSharing] = useState(false);
	const name = path?.split("/").at(-1) ?? "";
	const markdown = /\.(md|markdown)$/i.test(name);
	const html = isHtml(name) && htmlPreviewIsolated();
	const previewable = markdown || html;
	const handOff = (setBusy: (busy: boolean) => void, send: (file: AppFile) => Promise<void>, explain: (failure: unknown) => string = messageOf) => {
		if (!path) return;
		setBusy(true);
		void workspace
			.bytes(path)
			.then((bytes) => send(appFile(name, bytes)))
			.catch((failure: unknown) => setError(explain(failure)))
			.finally(() => setBusy(false));
	};

	useEffect(() => {
		if (!path) return;
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

	return (
		<Layer open={Boolean(path)} kind="page" onClose={onClose} label={name}>
			<div className="screen">
				<header className="bar">
					<BackButton onClick={onClose} />
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
							onClick={() =>
								handOff(setOpening, (file) => Apps.openFile(file), (failure) => (codeOf(failure) === "NO_APP" ? "手機上沒有能開這種檔案的 app" : messageOf(failure)))
							}
						>
							<OpenOutsideIcon />
						</button>
					) : null}
					{content ? (
						<button type="button" className="icon-button" aria-label="分享" disabled={sharing} onClick={() => handOff(setSharing, (file) => Apps.share({ title: name, ...file }))}>
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
						content.truncated ? <div className="ws-empty">超過 {content.limit / 1024 / 1024} MB，無法預覽</div> : <HtmlPreview html={content.text} />
					) : null}
					{content?.kind === "text" && !(previewable && mode === "preview") ? <CodeLines text={content.text} /> : null}
					{content?.kind === "text" && content.truncated && !(html && mode === "preview") ? <div className="note">只顯示前 {content.limit >= 1024 * 1024 ? `${content.limit / 1024 / 1024} MB` : `${content.limit / 1024} KB`}</div> : null}
				</div>
			</div>
		</Layer>
	);
}
