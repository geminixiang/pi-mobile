import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { entryText } from "../../src/agent/entries.ts";
import type { AgentRuntime, ConversationId } from "../../src/agent/runtime.ts";
import { openRuntime, turn } from "./fixtures.ts";
import type { Check } from "./setup.ts";

async function shown(runtime: AgentRuntime, id: ConversationId): Promise<ConversationView> {
	const controller = await runtime.openConversation(id);
	let view: ConversationView | undefined;
	controller.subscribe((next) => (view = next))();
	controller.dispose();
	assert(view);
	return view;
}

const userTexts = (view: ConversationView) => view.entries.filter((entry) => entry.kind === "pi.user").map(entryText);

export const checks: Check[] = [
	[
		"the chat shows every entry since the last reset, past pi-durable's 100-entry window, and none from before it",
		async () => {
			const { runtime } = await openRuntime();
			try {
				const bot = await runtime.createBot({ name: "tmp", job: "", avatar: "helper" });
				await turn(runtime, bot, [fauxAssistantMessage("old answer")], "before the reset");
				const controller = await runtime.openConversation(bot);
				await controller.reset();
				controller.dispose();
				for (let n = 0; n < 55; n++) await turn(runtime, bot, [fauxAssistantMessage(`answer ${n}`)], `question ${n}`);
				const view = await shown(runtime, bot);
				assert.equal(view.entries[0]?.kind, "pi.reset");
				assert.equal(userTexts(view).length, 55);
				assert(!userTexts(view).includes("before the reset"));
			} finally {
				await runtime.close();
			}
		},
	],
	[
		"an open chat drops what came before a reset made while it is open",
		async () => {
			const { runtime } = await openRuntime();
			try {
				const bot = await runtime.createBot({ name: "tmp", job: "", avatar: "helper" });
				await turn(runtime, bot, [fauxAssistantMessage("old answer")], "before the reset");
				const controller = await runtime.openConversation(bot);
				let view: ConversationView | undefined;
				const stop = controller.subscribe((next) => (view = next));
				await controller.reset();
				await turn(runtime, bot, [fauxAssistantMessage("new answer")], "after the reset");
				stop();
				controller.dispose();
				assert(view);
				assert.equal(view.entries[0]?.kind, "pi.reset");
				assert.deepEqual(userTexts(view), ["after the reset"]);
			} finally {
				await runtime.close();
			}
		},
	],
];
