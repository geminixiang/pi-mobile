import { Type } from "typebox";
import { type ConversationId, defineDoc, defineExtension, section } from "@earendil-works/pi-durable";
import { checkpointEvery64 } from "./doc-policy.ts";
import { defineAppTool, text } from "./tools/common.ts";
import { oneOf } from "./parse.ts";

export const MEMORY_LIMIT = 4000;

export type Memory = { text: string; updatedAt: number; updatedBy: "user" | "agent" | "" };

export const emptyMemory = (): Memory => ({ text: "", updatedAt: 0, updatedBy: "" });

export const MemoryDoc = defineDoc<Memory>({ kind: "app.memory", version: 1, scope: "session", initial: emptyMemory, checkpointWhen: checkpointEvery64 });

export const BotMemoryDoc = defineDoc<Memory>({
	kind: "app.bot.memory",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: emptyMemory,
	checkpointWhen: checkpointEvery64,
});

export type MemoryScope = { kind: "global" } | { kind: "bot"; id: ConversationId };

function editMemory(current: string, oldText: string | undefined, newText: string): string {
	if (!oldText) return current.trim() ? `${current.trimEnd()}\n${newText.trim()}` : newText.trim();
	const at = current.indexOf(oldText);
	if (at < 0) throw new Error("old_text is not in that MEMORY.md; copy it exactly from the memory section");
	if (current.indexOf(oldText, at + 1) >= 0) throw new Error("old_text occurs more than once; include more of the line");
	return `${current.slice(0, at)}${newText}${current.slice(at + oldText.length)}`.replace(/\n{3,}/g, "\n\n").trim();
}

export function createMemoryExtension(host: { changed: () => void }) {
	const updateMemory = defineAppTool({
		name: "update_memory",
		effect: "direct",
		reach: "model",
		callers: ["model"],
		description:
			"Edit a MEMORY.md. scope global: facts about the user that every bot should know. scope bot: your own notes for your job. Without old_text, new_text is added as a new line. With old_text (copied exactly from the memory section), it is replaced by new_text; an empty new_text deletes it.",
		parameters: Type.Object({
			scope: oneOf(["global", "bot"], { description: "global: every bot reads it; bot: only you" }),
			old_text: Type.Optional(Type.String({ description: "Exact text to replace; omit to append" })),
			new_text: Type.String({ description: "Markdown, usually one short line such as 「- 家：板橋府中站附近」" }),
		}),
		execute: async (args, api, context) => {
			const next = await api.commit(async (tx) => {
				const memory = args.scope === "global" ? await tx.doc(MemoryDoc) : await tx.doc(BotMemoryDoc, api.conversationId);
				const edited = editMemory(memory.text, args.old_text, args.new_text);
				if (edited.length > MEMORY_LIMIT) {
					throw new Error(`That MEMORY.md would be ${edited.length} characters, over the ${MEMORY_LIMIT} limit; shorten or remove old notes first`);
				}
				memory.text = edited;
				memory.updatedAt = Date.now();
				memory.updatedBy = "agent";
				return edited;
			}, context);
			host.changed();
			return text(
				`Saved. The ${args.scope} MEMORY.md is now ${next.length} characters. From your next step on, the memory section shows it; it was not there before, so do not apologize for asking.`,
			);
		},
	});

	return defineExtension({
		name: "memory",
		tools: [updateMemory],
		sections: [
			section("memory", async (input, context) => {
				const global = (await input.read.snapshot(MemoryDoc, context))?.text.trim() ?? "";
				const own = (await input.read.snapshot(BotMemoryDoc, input.conversationId, context))?.text.trim() ?? "";
				return [
					"Two MEMORY.md notes, both shown below; the user edits them in the app, you with update_memory, which applies at once. Use them without saying so.",
					"global: lasting facts and preferences about the user that every bot should know (home, work, family, diet, answer style). bot: what you need for your job (sources, people involved, how the user wants this work done, where things are).",
					"Save what lasts and anything the user asks you to remember, and say 「記住了」. Keep both short; update an entry instead of adding a duplicate. Never save one-offs, other people's private details, or secrets.",
					"When a request needs a missing fact (「回家要多久」 without a home), ask once and offer to remember it.",
					"",
					global ? `<global MEMORY.md>\n${global}\n</global MEMORY.md>` : "The global MEMORY.md is empty.",
					own ? `<bot MEMORY.md>\n${own}\n</bot MEMORY.md>` : "Your bot MEMORY.md is empty.",
				].join("\n");
			}),
		],
	});
}
