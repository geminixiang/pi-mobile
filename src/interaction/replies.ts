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
		`After a draft, a plan, a list of ideas, or an explanation with an obvious follow-up, end with one or two replies the user would likely send next, each on its own last line starting with ${MARK}, written as they would type it (${MARK} 改短一點); they become buttons. None after a plain fact, small talk or thanks, never 謝謝 or 好的. A question you need answered before going on is ask_user, not ${MARK}.`,
);
