import assert from "node:assert/strict";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createComputerAgentsExtension } from "../../src/computer-agents/tool.ts";
import type { Check } from "./setup.ts";

// why: the tool reads only conversationId from its api; a whole Harness is not what this check is about
const api = { conversationId: "bot-1" } as unknown as ToolExecutionApi;

function answerAgent(unattended: boolean) {
	const reached: string[] = [];
	const extension = createComputerAgentsExtension(
		(conversation) => {
			reached.push(conversation);
			return undefined;
		},
		{ changed: () => undefined, unattended: () => unattended, notify: async () => "off" },
	);
	const tool = extension.tools?.find((candidate) => candidate.name === "answer_agent");
	assert(tool, "answer_agent exists");
	return { reached, answer: () => tool.execute({ agent: "herdr:default:w1:p1", option: 1 }, api, BACKGROUND_CONTEXT) };
}

export const checks: Check[] = [
	[
		"a turn started by a schedule cannot answer an agent's question, and never reaches the computer: a notification must not be able to approve a command",
		async () => {
			const { reached, answer } = answerAgent(true);
			await assert.rejects(answer(), /started from a schedule/);
			assert.deepEqual(reached, []);
		},
	],
	[
		"a turn the user started does reach for the computer",
		async () => {
			const { reached, answer } = answerAgent(false);
			await assert.rejects(answer(), /works on the phone/);
			assert.deepEqual(reached, ["bot-1"]);
		},
	],
];
