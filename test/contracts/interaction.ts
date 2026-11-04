import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { AgentRuntime, ConversationId } from "../../src/agent/runtime.ts";
import { questionStates } from "../../src/interaction/answers.ts";
import { openRuntime, turn } from "./fixtures.ts";
import type { Check } from "./setup.ts";

async function entriesOf(runtime: AgentRuntime, id: ConversationId): Promise<readonly EntryRecord[]> {
	const controller = await runtime.openConversation(id);
	let entries: readonly EntryRecord[] = [];
	controller.subscribe((view) => (entries = view.entries))();
	controller.dispose();
	return entries;
}

const ASK = { question: "要從哪件開始？", options: ["排課表", "申請延長"] };

export const checks: Check[] = [
	[
		"a bot asks with ask_user, the card stays open until the user's next message, which becomes its answer",
		async () => {
			const { runtime } = await openRuntime();
			try {
				const bot = await runtime.createBot({ name: "tmp", job: "", avatar: "helper" });
				let offered = "";
				let toolResult = "";
				await turn(runtime, bot, [
					(context: TranscriptContext) => {
						offered = JSON.stringify(context);
						return fauxAssistantMessage(fauxToolCall("ask_user", ASK, { id: "ask-1" }), { stopReason: "toolUse" });
					},
					(context: TranscriptContext) => {
						toolResult = JSON.stringify(context.messages.at(-1));
						return fauxAssistantMessage("");
					},
				]);
				assert.match(offered, /"ask_user"/, "ask_user is offered to the model directly");
				assert.match(toolResult, /End your turn now/);
				assert.deepEqual(questionStates(await entriesOf(runtime, bot)).get("ask-1"), { state: "open" });

				await turn(runtime, bot, [fauxAssistantMessage("好，先申請延長。")], "申請延長");
				assert.deepEqual(questionStates(await entriesOf(runtime, bot)).get("ask-1"), { state: "answered", answer: "申請延長" });
			} finally {
				await runtime.close();
			}
		},
	],
];
