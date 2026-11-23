import { type MouseEvent, type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import { Type } from "typebox";
import type { FileContent, Workspace } from "../agent/sandbox/workspace.ts";
import { CodeLines, type Handed, handFile, handProblem, htmlPreviewIsolated } from "../app/files/FileViewer.tsx";
import { withCsp } from "../ui/csp.ts";
import { markdownComponents, remarkPlugins } from "../ui/markdown.tsx";
import { check } from "../parse.ts";
import { messageOf } from "pi-mobile-base/promise";
import { BLOCKS, changed, linesOf, markBlocks, squeezed } from "./changes.ts";
import { isHtml } from "../mime.ts";
import { promised, useStore } from "../ui/subscribed.ts";

export type Seen = { get: (path: string) => string | undefined; set: (path: string, text: string) => void };

const Picked = Type.Object({ pi: Type.Literal("pick"), text: Type.String() });
const MARKDOWN_FILE = /\.(md|markdown)$/i;

type Loaded = { state: "loading" } | { state: "failed"; problem: string } | { state: "read"; content: FileContent };
type Read = { loaded: Loaded; before: string | undefined; showBefore: boolean };

const UNREAD: Read = { loaded: { state: "loading" }, before: undefined, showBefore: false };

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
	const [source, setSource] = useState(false);
	const [handing, setHanding] = useState<Handed>();
	const [problem, setProblem] = useState<string>();
	const [read, setRead] = useStore<Read>(
		UNREAD,
		(listener) =>
			promised(() => workspace.read(path).then((content): Loaded => ({ state: "read", content }), (failure: unknown): Loaded => ({ state: "failed", problem: messageOf(failure) })))((next) => {
				const text = next.state === "read" && next.content.kind === "text" ? next.content.text : undefined;
				const last = seen.get(path) ?? previous;
				if (text !== undefined && last === undefined) seen.set(path, text);
				listener({ loaded: next, before: text !== undefined && last !== undefined && last !== text ? last : undefined, showBefore: false });
			}),
		[workspace, path, version, previous, seen],
	);
	const { loaded, before, showBefore } = read;
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
						<button type="button" onClick={() => setRead({ ...read, showBefore: !showBefore })}>
							{showBefore ? "看這一版" : "上一版"}
						</button>
					) : null}
					{before !== undefined && content?.kind === "text" ? (
						<button
							type="button"
							onClick={() => {
								seen.set(path, content.text);
								setRead({ ...read, before: undefined });
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
	const marks = useMemo(() => (before === undefined ? [] : [...changed(blockTexts(before), blockTexts(text))]), [before, text]);
	const pick = useRef(onPick);
	pick.current = onPick;
	const hear = useCallback((frame: HTMLIFrameElement) => {
		const listen = (event: MessageEvent) => {
			if (event.source !== frame.contentWindow) return;
			const read = check(Picked, event.data, "pick");
			if (read.ok) pick.current(read.value.text);
		};
		window.addEventListener("message", listen);
		return () => window.removeEventListener("message", listen);
	}, []);
	const doc = `${withCsp(text)}<script>${pickScript(marks, picked)}</script>`;
	return <iframe ref={hear} className="viewer-html" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={doc} title="預覽" />;
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

function MarkdownView({ text, before, picked, onPick }: { text: string; before: string | undefined; picked: string | undefined; onPick: (text: string) => void }) {
	const { parts, plugins } = useMemo(() => {
		const parts: string[] = [];
		return { parts, plugins: [markBlocks({ changed: before === undefined ? new Set() : changed(linesOf(before), linesOf(text)), picked, parts })] };
	}, [before, text, picked]);
	const pick = (event: MouseEvent<HTMLDivElement>) => {
		const block = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-block]") : null;
		const part = parts[Number(block?.dataset.block)];
		if (part) onPick(part);
	};
	return (
		<div className="answer viewer-markdown" onClick={pick}>
			<div className="markdown">
				<Markdown remarkPlugins={remarkPlugins} rehypePlugins={plugins} components={markdownComponents} skipHtml>
					{text}
				</Markdown>
			</div>
		</div>
	);
}
