import assert from "node:assert/strict";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { finalWord } from "../../src/triggers/runs.ts";
import type { Check } from "./setup.ts";

const assistant = (content: unknown): EntryRecord => JSON.parse(JSON.stringify({ kind: "pi.assistant", model: [{ role: "assistant", content }] }));
const text = (value: string) => ({ type: "text", text: value });

export const checks: Check[] = [
	[
		"a finished run is told by its last answer, not its opening line, and a question left open is what the user sees",
		async () => {
			const opening = assistant([text("好，我查一下明天的行程"), { type: "toolCall", id: "1", name: "codemode", arguments: {} }]);
			assert.deepEqual(finalWord([opening, assistant([text("明天 **10 點**開會\n\n記得帶筆電")])]), { headline: "明天 10 點開會", text: "記得帶筆電", asking: false });
			assert.deepEqual(finalWord([assistant([text("看[這裡](https://example.com/a)\n一\n二\n三\n四")])]), { headline: "看這裡", text: "一\n二\n三\n四", asking: false });
			const asked = assistant([{ type: "toolCall", id: "2", name: "ask_user", arguments: { question: "要幫你盯價格嗎？", options: ["每週查一次", "先不用"] } }]);
			assert.deepEqual(finalWord([assistant([text("查好了")]), asked]), { headline: "要幫你盯價格嗎？", text: "每週查一次、先不用", asking: true });
			assert.deepEqual(finalWord([]), { headline: "跑完了，沒有留下文字", text: "", asking: false });
		},
	],
];
