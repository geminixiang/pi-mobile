import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import type { FileContent, Workspace } from "../agent/sandbox/workspace.ts";
import { BackIcon } from "./icons.tsx";
import { markdownComponents, remarkPlugins } from "./Message.tsx";
import { Layer } from "./Sheet.tsx";

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
	const [copied, setCopied] = useState(false);
	const name = path?.split("/").at(-1) ?? "";
	const markdown = /\.(md|markdown)$/i.test(name);

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
			(failure: unknown) => live && setError(failure instanceof Error ? failure.message : String(failure)),
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
					{content?.kind === "text" ? (
						<button
							type="button"
							className="btn bar-action"
							onClick={() =>
								void navigator.clipboard.writeText(content.text).then(() => {
									setCopied(true);
									setTimeout(() => setCopied(false), 1500);
								})
							}
						>
							{copied ? "已複製" : "複製"}
						</button>
					) : null}
				</header>
				{markdown && content?.kind === "text" ? (
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
								{/* README badges and logos are inline HTML; the preview skips it rather than printing tags. */}
								<Markdown remarkPlugins={remarkPlugins} components={markdownComponents} skipHtml>
									{content.text}
								</Markdown>
							</div>
						</div>
					) : null}
					{content?.kind === "text" && !(markdown && mode === "preview") ? <CodeLines text={content.text} /> : null}
					{content?.kind === "text" && content.truncated ? <div className="note">只顯示前 512 KB</div> : null}
				</div>
			</div>
		</Layer>
	);
}
