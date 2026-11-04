import type { EntryRecord } from "@earendil-works/pi-durable";
import { blocks, entryText, message } from "../agent/entries.ts";
import { ASK_USER } from "./tool.ts";

export type Asked = { state: "open" } | { state: "answered"; answer: string };

export function questionStates(entries: readonly EntryRecord[]): ReadonlyMap<string, Asked> {
	const states = new Map<string, Asked>();
	entries.forEach((entry, index) => {
		if (entry.kind !== "pi.assistant") return;
		const reply = entries.slice(index + 1).find((later) => later.kind === "pi.user");
		const asked: Asked = reply ? { state: "answered", answer: entryText(reply).trim() } : { state: "open" };
		for (const block of blocks(message(entry)?.content)) {
			if (block.type === "toolCall" && block.name === ASK_USER) states.set(block.id, asked);
		}
	});
	return states;
}
