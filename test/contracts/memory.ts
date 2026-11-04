import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { createMemoryExtension, emptyMemory, MEMORY_LIMIT } from "../../src/agent/memory.ts";
import type { Check } from "./setup.ts";

function memory(text: string) {
	const stored = { ...emptyMemory(), text };
	const tool = createMemoryExtension({ changed: () => undefined }).tools?.find((candidate) => candidate.name === "update_memory");
	assert(tool, "update_memory exists");
	// why: the tool reads only commit and conversationId from its api, and tx.doc from its transaction; a whole Harness is not what these checks are about
	const api = { conversationId: "bot-1", commit: async (write: (tx: { doc(): Promise<typeof stored> }) => Promise<unknown>) => write({ doc: async () => stored }) } as unknown as ToolExecutionApi;
	return { stored, edit: (args: Record<string, unknown>) => tool.execute({ scope: "bot", ...args }, api, BACKGROUND_CONTEXT) };
}

export const checks: Check[] = [
	[
		"new text is a new line, and old text is replaced in place",
		async () => {
			const { stored, edit } = memory("- home: Taipei\n- work: Hsinchu");
			await edit({ new_text: "- cat: Mochi" });
			assert.equal(stored.text, "- home: Taipei\n- work: Hsinchu\n- cat: Mochi");
			await edit({ old_text: "- home: Taipei", new_text: "- home: Tainan" });
			assert.equal(stored.text, "- home: Tainan\n- work: Hsinchu\n- cat: Mochi");
			await edit({ old_text: "- work: Hsinchu\n", new_text: "" });
			assert.equal(stored.text, "- home: Tainan\n- cat: Mochi");
		},
	],
	[
		"text that is not there, or is there twice, changes nothing and says why, so a note is never lost to a guess",
		async () => {
			const { stored, edit } = memory("- a\n- a");
			await assert.rejects(edit({ old_text: "- b", new_text: "- c" }), /not in that MEMORY\.md/);
			await assert.rejects(edit({ old_text: "- a", new_text: "- c" }), /more than once/);
			assert.equal(stored.text, "- a\n- a");
		},
	],
	[
		"memory over the limit is refused and the old text stays",
		async () => {
			const { stored, edit } = memory("- a");
			await assert.rejects(edit({ new_text: "x".repeat(MEMORY_LIMIT) }), /over the/);
			assert.equal(stored.text, "- a");
		},
	],
];
