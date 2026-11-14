import type { EntryRecord } from "@earendil-works/pi-durable";
import { entryText, toolCalls } from "../agent/entries.ts";
import { ASK_USER } from "./tool.ts";

export type Asked = { state: "open" } | { state: "answered"; answer: string };

export function questionStates(entries: readonly EntryRecord[]): ReadonlyMap<string, Asked> {
	const states = new Map<string, Asked>();
	entries.forEach((entry, index) => {
		if (entry.kind !== "pi.assistant") return;
		const reply = entries.slice(index + 1).find((later) => later.kind === "pi.user");
		const asked: Asked = reply ? { state: "answered", answer: entryText(reply).trim() } : { state: "open" };
		for (const call of toolCalls(entry)) if (call.name === ASK_USER) states.set(call.id, asked);
	});
	return states;
}
