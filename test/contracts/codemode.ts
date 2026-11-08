import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { openRuntime, turn } from "./fixtures.ts";
import type { Check } from "./setup.ts";

export const checks: Check[] = [
	[
		"a script-only tool the model calls directly answers with how to call it from a script, so a weak model does not give up on it",
		async () => {
			const { runtime } = await openRuntime();
			try {
				const bot = await runtime.createBot({ name: "tmp", job: "", avatar: "helper" });
				let result = "";
				await turn(runtime, bot, [
					fauxAssistantMessage(fauxToolCall("list_schedules", {}, { id: "direct" }), { stopReason: "toolUse" }),
					(context: TranscriptContext) => {
						result = JSON.stringify(context.messages.at(-1));
						return fauxAssistantMessage("");
					},
				]);
				assert.match(result, /await tools\.list_schedules\(/);
			} finally {
				await runtime.close();
			}
		},
	],
];
