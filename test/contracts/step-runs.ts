import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { stepRuns } from "../../src/app/step-runs.ts";
import type { Check } from "./setup.ts";

let id = 0;
const assistant = (content: Parameters<typeof fauxAssistantMessage>[0]): EntryRecord => {
	// why: stepRuns reads only kind and the model message; the rest of a stored entry is not what this check is about
	return { id: ++id, kind: "pi.assistant", model: [fauxAssistantMessage(content)] } as unknown as EntryRecord;
};
// why: as above
const entry = (kind: string): EntryRecord => ({ id: ++id, kind }) as unknown as EntryRecord;
const call = (name: string) => fauxToolCall(name, {}, { id: name });

export const checks: Check[] = [
	[
		"tool calls in a row across messages fold into one line on the last of them, through their tool results",
		async () => {
			const first = assistant(call("a"));
			const second = assistant([call("b"), call("c")]);
			const third = assistant(call("d"));
			const runs = stepRuns([first, entry("pi.tool-result"), second, entry("pi.tool-result"), third]);
			assert.equal(runs.get(first)?.hidden, true);
			assert.equal(runs.get(second)?.hidden, true);
			assert.equal(runs.get(third)?.hidden, false);
			assert.deepEqual(runs.get(third)?.carried.map((block) => block.name), ["a", "b", "c"]);
		},
	],
	[
		"text the user can read, a user message or a question card ends the line",
		async () => {
			const before = assistant(call("a"));
			const spoken = assistant(["好，接著查", call("b")].map((part) => (typeof part === "string" ? { type: "text" as const, text: part } : part)));
			assert.equal(stepRuns([before, spoken]).get(before), undefined);
			const asked = assistant(call("a"));
			const question = assistant(fauxToolCall("ask_user", {}, { id: "ask" }));
			assert.equal(stepRuns([asked, question]).get(asked), undefined);
			const earlier = assistant(call("a"));
			const later = assistant(call("b"));
			assert.equal(stepRuns([earlier, entry("pi.user"), later]).size, 0);
		},
	],
];
