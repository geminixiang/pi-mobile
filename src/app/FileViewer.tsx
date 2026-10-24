import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import { type FileContent, isHtml, type Workspace } from "../agent/sandbox/workspace.ts";
import { Apps, base64, MIME_TYPES } from "../agent/tools/apps.ts";
import { BackIcon, OpenOutsideIcon, ShareIcon } from "./icons.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { markdownComponents, remarkPlugins } from "./Message.tsx";
import { Layer } from "./Sheet.tsx";
import { messageOf } from "../promise.ts";

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
	const mimeType = MIME_TYPES[name.split(".").at(-1)?.toLowerCase() ?? ""] ?? "application/octet-stream";
	const share = () => {
		if (!path) return;
		setSharing(true);
		void workspace
			.bytes(path)
			.then((bytes) => Apps.share({ title: name, fileBase64: base64(bytes), fileName: name, mimeType }))
			.catch((failure: unknown) => setError(messageOf(failure)))
			.finally(() => setSharing(false));
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
					<button type="button" className="icon-button" onClick={onClose} aria-label="返回">
						<BackIcon />
					</button>
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
							onClick={() => {
								if (!path) return;
								setOpening(true);
								void workspace
									.bytes(path)
									.then((bytes) => Apps.openFile({ fileBase64: base64(bytes), fileName: name, mimeType }))
									.catch((failure: unknown) => {
										const code = typeof failure === "object" && failure !== null ? Reflect.get(failure, "code") : undefined;
										setError(code === "NO_APP" ? "手機上沒有能開這種檔案的 app" : messageOf(failure));
									})
									.finally(() => setOpening(false));
							}}
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
					<div className="tabs" role="tablist">
						{(
							[
								["preview", "預覽"],
								["source", "原始碼"],
							] as const
						).map(([value, label]) => (
							<button type="button" role="tab" key={value} aria-selected={mode === value} className={mode === value ? "selected" : ""} onClick={() => setMode(value)}>
								{label}
							</button>
						))}
					</div>
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
