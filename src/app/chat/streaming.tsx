import { memo, useCallback, useRef, useSyncExternalStore } from "react";
import Markdown from "react-markdown";
import remend from "remend";
import { eachFrame } from "../../time.ts";
import { remarkPlugins, streamingMarkdownComponents } from "../../ui/markdown.tsx";

const CATCH_UP_MS = 160;

function boundary(text: string, index: number): number {
	const code = text.charCodeAt(index - 1);
	return code >= 0xd800 && code <= 0xdbff ? index + 1 : index;
}

function useSmoothText(text: string): string {
	const state = useRef({ shown: 0, target: text });
	state.current.target = text;
	const follow = useCallback((changed: () => void) => {
		let last = performance.now();
		return eachFrame((now) => {
			const { target, shown } = state.current;
			const elapsed = Math.min(now - last, 100);
			last = now;
			const behind = target.length - shown;
			if (behind === 0) return;
			state.current.shown = behind > 0 ? boundary(target, Math.min(target.length, shown + Math.max(1, Math.ceil((behind * elapsed) / CATCH_UP_MS)))) : target.length;
			changed();
		});
	}, []);
	const shown = useSyncExternalStore(follow, () => state.current.shown);
	return text.slice(0, Math.min(shown, text.length));
}

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
		<Markdown remarkPlugins={remarkPlugins} components={streamingMarkdownComponents}>
			{text}
		</Markdown>
	);
});

export function StreamingMarkdown({ text }: { text: string }) {
	const parts = paragraphs(useSmoothText(text));
	return parts.map((part, index) => <Paragraph key={index} text={index === parts.length - 1 ? remend(part) : part} />);
}
