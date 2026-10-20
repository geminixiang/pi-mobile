// MEMORY.md: what pi should know about the user in every conversation (home, work, people, preferences). One
// Markdown note, stored on the phone in the session; the user edits it on its own page, the agent with update_memory.
// Every request carries it in the system prompt, so it also reaches the model service.
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable";

/** Long enough for a page of notes; short enough that sending it with every request costs little. */
export const MEMORY_LIMIT = 4000;

// A type alias, not an interface: documents need JSON-assignable types.
export type Memory = { text: string; updatedAt: number; updatedBy: "user" | "agent" | "" };

export const MemoryDoc = defineDoc<Memory>({
	kind: "app.memory",
	version: 1,
	scope: "session",
	initial: () => ({ text: "", updatedAt: 0, updatedBy: "" }),
});

const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });

/** Apply one edit: replace `oldText` (which must occur exactly once), or append `newText` as its own line. */
export function editMemory(current: string, oldText: string | undefined, newText: string): string {
	if (!oldText) return current.trim() ? `${current.trimEnd()}\n${newText.trim()}` : newText.trim();
	const at = current.indexOf(oldText);
	if (at < 0) throw new Error("old_text is not in MEMORY.md; copy it exactly from the memory section");
	if (current.indexOf(oldText, at + 1) >= 0) throw new Error("old_text occurs more than once; include more of the line");
	return `${current.slice(0, at)}${newText}${current.slice(at + oldText.length)}`.replace(/\n{3,}/g, "\n\n").trim();
}

export function createMemoryExtension(host: { changed: () => void }) {
	const updateMemory = defineTool({
		name: "update_memory",
		description:
			"Edit MEMORY.md, the user's notes that every conversation sees. Without old_text, new_text is added as a new line. With old_text (copied exactly from the memory section), it is replaced by new_text; an empty new_text deletes it.",
		parameters: Type.Object({
			old_text: Type.Optional(Type.String({ description: "Exact text to replace; omit to append" })),
			new_text: Type.String({ description: "Markdown, usually one short line such as 「- 家：板橋府中站附近」" }),
		}),
		execute: async (args, api, context) => {
			const next = await api.commit(async (tx) => {
				const memory = await tx.doc(MemoryDoc);
				const edited = editMemory(memory.text, args.old_text, args.new_text);
				if (edited.length > MEMORY_LIMIT) {
					throw new Error(`MEMORY.md would be ${edited.length} characters, over the ${MEMORY_LIMIT} limit; shorten or remove old notes first`);
				}
				memory.text = edited;
				memory.updatedAt = Date.now();
				memory.updatedBy = "agent";
				return edited;
			}, context);
			host.changed();
			return text(`Saved. MEMORY.md is now ${next.length} characters.`);
		},
	});

	return defineExtension({
		name: "memory",
		tools: [updateMemory],
		sections: [
			section("memory", async (input, context) => {
				const memory = (await input.read.snapshot(MemoryDoc, context))?.text.trim() ?? "";
				return [
					"MEMORY.md holds what the user wants you to know in every conversation. The user can read and edit it in the app (對話列表 → 記憶).",
					"Use it without saying you looked it up. When the user states a lasting fact or preference (where home or work is, family, diet, how they like answers) or asks you to remember something, save it with update_memory and say so in a few words (「記住了」). Keep entries short and grouped; update an entry instead of adding a duplicate.",
					"Do not save one-off details, things about other people they would not want kept, or secrets such as passwords and keys. When a request needs something that is not there (「回家要多久」 without a home), ask for it once and offer to remember it.",
					"",
					memory ? `<MEMORY.md>\n${memory}\n</MEMORY.md>` : "MEMORY.md is empty.",
				].join("\n");
			}),
		],
	});
}
