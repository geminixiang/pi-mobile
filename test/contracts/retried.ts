import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { retriedAttempts } from "../../src/agent/entries.ts";
import type { Check } from "./setup.ts";

const prompt = { kind: "pi.user", model: [{ role: "user" as const, content: "stream", timestamp: 0 }] };
const failed = (text: string) => ({ kind: "pi.assistant", model: [fauxAssistantMessage(text, { stopReason: "error", errorMessage: "connection lost: the network went away" })] });
const answered = { kind: "pi.assistant", model: [fauxAssistantMessage("答案")] };

export const checks: Check[] = [
	[
		"failed attempts that a retry followed fold into one line, and the answer that came through does not",
		async () => {
			const first = failed("半截");
			const second = failed("");
			const shown = retriedAttempts([prompt, first, second, answered], false);
			assert.deepEqual([...shown], [first, second]);
		},
	],
	[
		"the last failed attempt folds only while its retry is pending, so one that gave up still shows its error",
		async () => {
			const last = failed("半截");
			assert.deepEqual([...retriedAttempts([prompt, last], true)], [last]);
			assert.deepEqual([...retriedAttempts([prompt, last], false)], []);
		},
	],
	[
		"a failed answer followed by the next question is not a retried attempt",
		async () => {
			const gaveUp = failed("半截");
			assert.deepEqual([...retriedAttempts([prompt, gaveUp, prompt, answered], false)], []);
		},
	],
];
