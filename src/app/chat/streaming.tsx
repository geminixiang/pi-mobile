import { memo, useCallback, useRef, useSyncExternalStore } from "react";
import Markdown from "react-markdown";
import remend from "remend";
import { eachFrame } from "pi-mobile-base/time";
import { remarkPlugins, streamingMarkdownComponents } from "pi-mobile-ui/message";
import type { Source } from "pi-mobile-ui/store";

const CATCH_UP_MS = 160;
const HELD_WRITE_MS = 1000;

export type Held = Source<boolean>;

function boundary(text: string, index: number): number {
	const code = text.charCodeAt(index - 1);
	return code >= 0xd800 && code <= 0xdbff ? index + 1 : index;
}

function useSmoothText(text: string, held: Held): string {
	const state = useRef({ shown: 0, target: text, held, written: 0 });
	state.current.target = text;
	state.current.held = held;
	const follow = useCallback((changed: () => void) => {
		let last = performance.now();
		return eachFrame((now) => {
			const { target, shown, written } = state.current;
			const elapsed = Math.min(now - last, 100);
			last = now;
			const behind = target.length - shown;
			if (behind === 0) return;
			const hold = state.current.held.read();
			if (hold && now - written < HELD_WRITE_MS) return;
			state.current.shown = hold || behind < 0 ? target.length : boundary(target, Math.min(target.length, shown + Math.max(1, Math.ceil((behind * elapsed) / CATCH_UP_MS))));
			state.current.written = now;
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

export function StreamingMarkdown({ text, held }: { text: string; held: Held }) {
	const parts = paragraphs(useSmoothText(text, held));
	return parts.map((part, index) => <Paragraph key={index} text={index === parts.length - 1 ? remend(part) : part} />);
}
