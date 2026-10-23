import type { Element, ElementContent, Root } from "hast";
import { memo, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remend from "remend";
import { remarkPlugins, streamingMarkdownComponents } from "./Message.tsx";

const CATCH_UP_MS = 160;

function boundary(text: string, index: number): number {
	const code = text.charCodeAt(index - 1);
	return code >= 0xd800 && code <= 0xdbff ? index + 1 : index;
}

function useSmoothText(text: string): string {
	const [shown, setShown] = useState(0);
	const state = useRef({ shown: 0, target: text });
	state.current.target = text;
	useEffect(() => {
		let frame = 0;
		let last = performance.now();
		const step = (now: number) => {
			const { target } = state.current;
			const elapsed = Math.min(now - last, 100);
			last = now;
			const behind = target.length - state.current.shown;
			if (behind > 0) {
				const next = Math.min(target.length, state.current.shown + Math.max(1, Math.ceil((behind * elapsed) / CATCH_UP_MS)));
				state.current.shown = boundary(target, next);
				setShown(state.current.shown);
			} else if (behind < 0) {
				state.current.shown = target.length;
				setShown(target.length);
			}
			frame = requestAnimationFrame(step);
		};
		frame = requestAnimationFrame(step);
		return () => cancelAnimationFrame(frame);
	}, []);
	return text.slice(0, Math.min(shown, text.length));
}

const segmenter = new Intl.Segmenter("zh-Hant", { granularity: "word" });

function rehypeFadeIn() {
	const wrap = (parent: Root | Element) => {
		const children: ElementContent[] = [];
		for (const child of parent.children) {
			if (child.type === "text") {
				for (const { segment } of segmenter.segment(child.value)) {
					children.push({ type: "element", tagName: "span", properties: { className: ["fade"] }, children: [{ type: "text", value: segment }] });
				}
			} else if (child.type === "element") {
				if (child.tagName !== "pre") wrap(child);
				children.push(child);
			} else if (child.type !== "doctype") {
				children.push(child);
			}
		}
		parent.children = children;
	};
	return (tree: Root) => wrap(tree);
}

const rehypePlugins = [rehypeFadeIn];

function paragraphs(text: string): string[] {
	const out: string[] = [];
	let current: string[] = [];
	let fenced = false;
	for (const line of text.split("\n")) {
		if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
		if (!fenced && line.trim() === "" && current.length > 0) {
			out.push(current.join("\n"));
			current = [];
			continue;
		}
		current.push(line);
	}
	if (current.length > 0) out.push(current.join("\n"));
	return out;
}

const Paragraph = memo(function Paragraph({ text }: { text: string }) {
	return (
		<Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={streamingMarkdownComponents}>
			{text}
		</Markdown>
	);
});

export function StreamingMarkdown({ text }: { text: string }) {
	const parts = paragraphs(useSmoothText(text));
	return parts.map((part, index) => <Paragraph key={index} text={index === parts.length - 1 ? remend(part) : part} />);
}
