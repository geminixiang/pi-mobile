import assert from "node:assert/strict";
import { contentText, fauxAssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { localTime } from "../../src/agent/tools/common.ts";
import { openRuntime, turn } from "./fixtures.ts";
import type { Check } from "./setup.ts";

const userTexts = (context: TranscriptContext) => context.messages.flatMap((message) => (message.role === "user" ? [{ text: contentText(message.content), sent: message.timestamp }] : []));

export const checks: Check[] = [
	[
		"the model reads each user message with the local time it was sent, the same on every later request, and the transcript keeps what the user typed",
		async () => {
			const { runtime } = await openRuntime();
			try {
				const bot = await runtime.createBot({ name: "tmp", job: "", avatar: "helper" });
				const requests: { text: string; sent: number }[][] = [];
				const answer = (context: TranscriptContext) => {
					requests.push(userTexts(context));
					return fauxAssistantMessage("done");
				};
				await turn(runtime, bot, [answer], "明天有啥");
				await turn(runtime, bot, [answer], "等等提醒我");
				const [first, second] = requests;
				assert(first && second);
				const stamp = (sent: number) => `[${new Date(sent).toLocaleDateString("en-US", { weekday: "short" })} ${localTime(sent)}]\n`;
				assert.deepEqual(
					second.map(({ text }) => text),
					second.map(({ sent }, index) => stamp(sent) + ["明天有啥", "等等提醒我"][index]),
				);
				assert.equal(first[0]?.text, second[0]?.text);
				const controller = await runtime.openConversation(bot);
				let typed: string[] = [];
				controller.subscribe((view) => {
					typed = view.entries.flatMap((entry) => (entry.kind === "pi.user" ? (entry.model ?? []).map((message) => contentText(message.content)) : []));
				})();
				controller.dispose();
				assert.deepEqual(typed, ["明天有啥", "等等提醒我"]);
			} finally {
				await runtime.close();
			}
		},
	],
];
