import type { Element as HastElement, Root, RootContent } from "hast";
import { type MouseEvent, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import { Type } from "typebox";
import { type FileContent, isHtml, type Workspace } from "../agent/sandbox/workspace.ts";
import { CodeLines, type Handed, handFile, handProblem, htmlPreviewIsolated, withCsp } from "../app/FileViewer.tsx";
import { markdownComponents, remarkPlugins } from "../app/markdown.tsx";
import { check } from "../parse.ts";
import { messageOf } from "../promise.ts";
import { BLOCKS, changed, linesOf, squeezed } from "./changes.ts";

export type Seen = { get: (path: string) => string | undefined; set: (path: string, text: string) => void };

const Picked = Type.Object({ pi: Type.Literal("pick"), text: Type.String() });
const MARKDOWN_FILE = /\.(md|markdown)$/i;

type Loaded = { state: "loading" } | { state: "failed"; problem: string } | { state: "read"; content: FileContent };

export function Surface({
	workspace,
	path,
	version,
	previous,
	seen,
	picked,
	onPick,
	actions,
}: {
	workspace: Workspace;
	path: string;
	version: number;
	previous: string | undefined;
	seen: Seen;
	picked: string | undefined;
	onPick: (text: string) => void;
	actions?: ReactNode;
}) {
	const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
	const [before, setBefore] = useState<string>();
	const [showBefore, setShowBefore] = useState(false);
	const [source, setSource] = useState(false);
	const [handing, setHanding] = useState<Handed>();
	const [problem, setProblem] = useState<string>();
	useEffect(() => {
		let live = true;
		workspace.read(path).then(
			(content) => {
				if (!live) return;
				const text = content.kind === "text" ? content.text : undefined;
				const last = seen.get(path) ?? previous;
				if (text !== undefined && last === undefined) seen.set(path, text);
				setBefore(text !== undefined && last !== undefined && last !== text ? last : undefined);
				setShowBefore(false);
				setLoaded({ state: "read", content });
			},
			(failure: unknown) => live && setLoaded({ state: "failed", problem: messageOf(failure) }),
		);
		return () => {
			live = false;
		};
	}, [workspace, path, version, previous, seen]);
	const hand = (how: Handed) => {
		setHanding(how);
		setProblem(undefined);
		void handFile(workspace, path, how)
			.catch((failure: unknown) => setProblem(handProblem(failure)))
			.finally(() => setHanding(undefined));
	};
	const content = loaded.state === "read" ? loaded.content : undefined;
	const text = content?.kind === "text" ? (showBefore && before !== undefined ? before : content.text) : undefined;
	const marked = before !== undefined && !showBefore;
	const html = isHtml(path) && htmlPreviewIsolated();
	const markdown = MARKDOWN_FILE.test(path);
	const tally = marked && before !== undefined && text !== undefined ? (html ? tallyOf(blockTexts(before), blockTexts(text), "處") : tallyOf(linesOf(before), linesOf(text), "行")) : "";
	const view = text === undefined ? null : html && !source ? (
		<HtmlView text={text} before={marked ? before : undefined} picked={picked} onPick={onPick} />
	) : markdown && !source ? (
		<MarkdownView text={text} before={marked ? before : undefined} picked={picked} onPick={onPick} />
	) : (
		<CodeLines text={text} marks={{ changed: marked && before !== undefined ? changed(linesOf(before), linesOf(text)) : new Set(), picked, onPick }} />
	);
	return (
		<>
			<div className={`surface${showBefore ? " before" : ""}`}>
				{loaded.state === "loading" ? <div className="ws-loading">讀取中</div> : null}
				{loaded.state === "failed" ? <div className="banner error">{loaded.problem}</div> : null}
				{content?.kind === "binary" ? <div className="ws-empty">二進位檔案，無法顯示</div> : null}
				{content?.kind === "image" ? <img className="viewer-image" src={content.url} alt="" /> : null}
				{view}
			</div>
			<div className="stage-verbs">
				{actions}
				<span className="inline-verbs">
					{before !== undefined ? (
						<button type="button" onClick={() => setShowBefore(!showBefore)}>
							{showBefore ? "看這一版" : "上一版"}
						</button>
					) : null}
					{before !== undefined && content?.kind === "text" ? (
						<button
							type="button"
							onClick={() => {
								seen.set(path, content.text);
								setBefore(undefined);
							}}
						>
							看過了
						</button>
					) : null}
					{(html || markdown) && content?.kind === "text" ? (
						<button type="button" onClick={() => setSource(!source)}>
							{source ? "預覽" : "原始碼"}
						</button>
					) : null}
					<button type="button" disabled={handing !== undefined} onClick={() => hand("share")}>
						分享
					</button>
					<button type="button" disabled={handing !== undefined} onClick={() => hand("open")}>
						用 App 開
					</button>
				</span>
				{tally ? <span className="stage-aside changed-tally">{tally}</span> : null}
				{problem ? <p className="item-problem">{problem}</p> : null}
			</div>
		</>
	);
}

function tallyOf(before: readonly string[], after: readonly string[], unit: string): string {
	const added = changed(before, after).size;
	const removed = changed(after, before).size;
	return [added > 0 ? `改了 ${added} ${unit}` : "", removed > added ? `刪了 ${removed - added} ${unit}` : ""].filter(Boolean).join(" · ");
}

function blockTexts(html: string): string[] {
	return [...new DOMParser().parseFromString(html, "text/html").querySelectorAll(BLOCKS)].map((element) => squeezed(element.textContent ?? ""));
}

function HtmlView({ text, before, picked, onPick }: { text: string; before: string | undefined; picked: string | undefined; onPick: (text: string) => void }) {
	const frame = useRef<HTMLIFrameElement>(null);
	const marks = useMemo(() => (before === undefined ? [] : [...changed(blockTexts(before), blockTexts(text))]), [before, text]);
	useEffect(() => {
		const listen = (event: MessageEvent) => {
			if (event.source !== frame.current?.contentWindow) return;
			const read = check(Picked, event.data, "pick");
			if (read.ok) onPick(read.value.text);
		};
		window.addEventListener("message", listen);
		return () => window.removeEventListener("message", listen);
	}, [onPick]);
	const doc = `${withCsp(text)}<script>${pickScript(marks, picked)}</script>`;
	return <iframe ref={frame} className="viewer-html" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={doc} title="預覽" />;
}

function pickScript(marks: readonly number[], picked: string | undefined): string {
	const data = JSON.stringify({ marks, picked: picked ?? "", blocks: BLOCKS }).replaceAll("<", "\\u003c");
	return `(() => {
const { marks, picked, blocks } = ${data};
const squeeze = (text) => text.replace(/\\s+/g, " ").trim();
const style = document.createElement("style");
style.textContent = "html body .pi-changed, html body .pi-changed > td, html body .pi-changed > th { background-color: rgb(241 190 88 / 0.3); } html body .pi-picked, html body .pi-picked > td { box-shadow: inset 0 0 0 2px #4b607c; } " + blocks.split(",").map((tag) => tag.trim() + ":hover").join(", ") + " { cursor: pointer; }";
document.head.append(style);
const all = [...document.querySelectorAll(blocks)];
all.forEach((element, index) => {
	if (marks.includes(index)) element.classList.add("pi-changed");
	if (picked && squeeze(element.innerText) === picked) element.classList.add("pi-picked");
});
const first = all[marks[0]];
if (first && first.getBoundingClientRect().bottom > innerHeight) window.scrollTo(0, first.getBoundingClientRect().top + scrollY - innerHeight / 3);
document.addEventListener("click", (event) => {
	const block = event.target.closest(blocks);
	if (block) parent.postMessage({ pi: "pick", text: squeeze(block.innerText) }, "*");
});
})();`;
}

function markChanged(lines: ReadonlySet<number>) {
	const visit = (node: Root | RootContent) => {
		if (node.type === "element") mark(node);
		if ("children" in node) for (const child of node.children) visit(child);
	};
	const mark = (element: HastElement) => {
		const start = element.position?.start.line;
		const end = element.position?.end.line;
		if (start === undefined || end === undefined || !BLOCKS.split(", ").includes(element.tagName)) return;
		if (Array.from({ length: end - start + 1 }, (_, index) => start - 1 + index).some((line) => lines.has(line))) element.properties.className = ["changed"];
	};
	return () => (tree: Root) => visit(tree);
}

function MarkdownView({ text, before, picked, onPick }: { text: string; before: string | undefined; picked: string | undefined; onPick: (text: string) => void }) {
	const box = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		for (const block of box.current?.querySelectorAll<HTMLElement>(BLOCKS) ?? []) block.classList.toggle("picked", picked !== undefined && squeezed(block.innerText) === picked);
	}, [picked, text]);
	const plugins = useMemo(() => [markChanged(before === undefined ? new Set() : changed(linesOf(before), linesOf(text)))], [before, text]);
	const pick = (event: MouseEvent<HTMLDivElement>) => {
		const block = event.target instanceof Element ? event.target.closest(BLOCKS) : null;
		if (block instanceof HTMLElement) onPick(squeezed(block.innerText));
	};
	return (
		<div className="answer viewer-markdown" ref={box} onClick={pick}>
			<div className="markdown">
				<Markdown remarkPlugins={remarkPlugins} rehypePlugins={plugins} components={markdownComponents} skipHtml>
					{text}
				</Markdown>
			</div>
		</div>
	);
}
