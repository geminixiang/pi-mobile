import type { EntryRecord } from "@earendil-works/pi-durable";
import { type Block, entryText } from "../agent/entries.ts";
import { appSection } from "../agent/section.ts";

const MARK = "↳";
const MOST = 2;

export type Replied = { text: string; replies: readonly string[] };

export function splitReplies(text: string): Replied {
	const lines = text.trimEnd().split("\n");
	const start = lines.findLastIndex((line) => !line.trim().startsWith(MARK)) + 1;
	const replies = lines
		.slice(start)
		.map((line) => line.trim().slice(MARK.length).trim())
		.filter(Boolean)
		.slice(0, MOST);
	return { text: lines.slice(0, start).join("\n").trimEnd(), replies };
}

export function answerOf(entry: EntryRecord): Replied {
	return splitReplies(entryText(entry));
}

export function withoutReplies(content: readonly Block[]): readonly Block[] {
	const last = content.findLastIndex((block) => block.type === "text");
	return content.flatMap((block, index) => {
		if (index !== last || block.type !== "text") return [block];
		const { text } = splitReplies(block.text);
		return text ? [{ ...block, text }] : [];
	});
}

export const repliesSection = appSection(
	"replies",
	500,
	() =>
		`An answer that hands the user something to use or choose from (a draft, a plan, ideas, options, steps) ends with one or two lines starting with ${MARK}: what they would most likely send next, in their words (${MARK} 改短一點, ${MARK} 第二個說詳細一點). They become buttons, so the user taps instead of typing. Leave them out after a plain fact, small talk or thanks, and never ${MARK} 謝謝 or ${MARK} 好的. A question you must have answered before going on is ask_user, not ${MARK}.`,
);
