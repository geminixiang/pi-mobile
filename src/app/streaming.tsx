// A streaming answer's text, shown smoothly. Text arrives in bursts (on the S24 a dozen characters every 150 ms or
// so, the first up to a few hundred), which read as a stutter: still, jump, still, jump. Three parts:
//
// - useSmoothText reveals what has arrived a little every frame, at a pace that catches up within about one burst's
//   interval, so the text grows continuously and never falls far behind.
// - remend completes Markdown that is still open (an unclosed ** or code fence), so a half-written marker does not
//   flash as text and then turn into formatting.
// - rehypeFadeIn wraps the text in word spans; React keeps the spans already on screen, so only the words just
//   revealed mount, and their CSS fade (styles.css .fade) plays once.
//
// Only the paragraph being written is parsed each frame: the text is cut at blank lines outside code fences, and the
// finished paragraphs are memoized. Parsing all of it every frame dropped 3% of frames on the S24.
import type { Element, ElementContent, Root } from "hast";
import { memo, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remend from "remend";
import { remarkPlugins, streamingMarkdownComponents } from "./Message.tsx";

/** How long the reveal takes to catch up with what has arrived: about one burst's interval. */
const CATCH_UP_MS = 160;

/** Do not end between the halves of a surrogate pair (an emoji, a rare CJK character). */
function boundary(text: string, index: number): number {
	const code = text.charCodeAt(index - 1);
	return code >= 0xd800 && code <= 0xdbff ? index + 1 : index;
}

export function useSmoothText(text: string): string {
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
				// The share of the backlog this frame covers, so all of it is shown within CATCH_UP_MS.
				const next = Math.min(target.length, state.current.shown + Math.max(1, Math.ceil((behind * elapsed) / CATCH_UP_MS)));
				state.current.shown = boundary(target, next);
				setShown(state.current.shown);
			} else if (behind < 0) {
				// The text was replaced (a retry): start over from what is there.
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

/** Text into word spans (Chinese by dictionary words), outside code blocks, so the newest words can fade in. */
function rehypeFadeIn() {
	const wrap = (parent: Root | Element) => {
		const children: ElementContent[] = [];
		for (const child of parent.children) {
			if (child.type === "text") {
				for (const { segment } of segmenter.segment(child.value)) {
					children.push({ type: "element", tagName: "span", properties: { className: ["fade"] }, children: [{ type: "text", value: segment }] });
				}
			} else if (child.type === "element") {
				// Code stays plain: the copy button reads its text, and code arrives line by line anyway.
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

/** Paragraphs: the text cut at blank lines, but not inside a fenced code block. */
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

/** The streaming part of an answer: revealed smoothly, completed, and faded in by word. */
export function StreamingMarkdown({ text }: { text: string }) {
	const parts = paragraphs(useSmoothText(text));
	// The last paragraph is still being written: complete what it leaves open. The others are done.
	return parts.map((part, index) => <Paragraph key={index} text={index === parts.length - 1 ? remend(part) : part} />);
}
