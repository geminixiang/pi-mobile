import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { AgentRuntime, ConversationId } from "../../src/agent/runtime.ts";
import { Value } from "typebox/value";
import { questionStates } from "../../src/interaction/answers.ts";
import { AskArgs } from "../../src/interaction/tool.ts";
import { answerOf, splitReplies, withoutReplies } from "../../src/interaction/replies.ts";
import { finalWord } from "../../src/triggers/runs.ts";
import { pageCards } from "../../src/interaction/pages.ts";
import { addResult, type ResultCard } from "../../src/interaction/results.ts";
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
		"an answer that ends in ↳ lines offers them as replies, and its text, copy and notification leave them out",
		async () => {
			const { runtime } = await openRuntime();
			try {
				const bot = await runtime.createBot({ name: "tmp", job: "", avatar: "helper" });
				let prompt = "";
				await turn(runtime, bot, [
					(context: TranscriptContext) => {
						prompt = JSON.stringify(context);
						return fauxAssistantMessage("草稿寫好了，在上面。\n\n↳ 改短一點\n↳ 語氣正式一點");
					},
				]);
				assert.match(prompt, /starting with ↳/, "the model is told how to offer replies");
				const entries = await entriesOf(runtime, bot);
				const last = entries.findLast((entry) => entry.kind === "pi.assistant");
				assert.ok(last);
				assert.deepEqual(answerOf(last), { text: "草稿寫好了，在上面。", replies: ["改短一點", "語氣正式一點"] });
				assert.deepEqual(finalWord(entries), { headline: "草稿寫好了，在上面。", text: "", asking: false });
			} finally {
				await runtime.close();
			}
		},
	],
	[
		"only the ↳ lines at the end are replies, at most two, and a block that held only them is dropped",
		async () => {
			assert.deepEqual(splitReplies("步驟：\n↳ 先開機\n然後登入"), { text: "步驟：\n↳ 先開機\n然後登入", replies: [] });
			assert.deepEqual(splitReplies("好了\n↳ 一\n  ↳ 二  \n↳ 三\n"), { text: "好了", replies: ["一", "二"] });
			assert.deepEqual(splitReplies("好了\n↳"), { text: "好了", replies: [] });
			const content = withoutReplies([{ type: "text", text: "先查" }, { type: "toolCall", id: "1", name: "codemode", arguments: {} }, { type: "text", text: "↳ 再查一次" }]);
			assert.deepEqual(content.map((block) => block.type), ["text", "toolCall"]);
		},
	],
	[
		"a bot asks with ask_user, the card stays open until the user's next message, which becomes its answer",
		async () => {
			const { runtime } = await openRuntime();
			try {
				const bot = await runtime.createBot({ name: "tmp", job: "", avatar: "helper" });
				let offered = "";
				let askedAgain = false;
				await turn(runtime, bot, [
					(context: TranscriptContext) => {
						offered = JSON.stringify(context);
						return fauxAssistantMessage(fauxToolCall("ask_user", ASK, { id: "ask-1" }), { stopReason: "toolUse" });
					},
					() => {
						askedAgain = true;
						return fauxAssistantMessage("(waiting for your answer)");
					},
				]);
				assert.match(offered, /"ask_user"/, "ask_user is offered to the model directly");
				assert.equal(askedAgain, false, "the card ends the turn, so the model is not asked to say something after it");
				assert.deepEqual(questionStates(await entriesOf(runtime, bot)).get("ask-1"), { state: "open" });

				await turn(runtime, bot, [fauxAssistantMessage("好，先申請延長。")], "申請延長");
				assert.deepEqual(questionStates(await entriesOf(runtime, bot)).get("ask-1"), { state: "answered", answer: "申請延長" });
			} finally {
				await runtime.close();
			}
		},
	],
	[
		"a question that asks to approve a send can carry the full text, and the model is told a file it wrote is not visible to the user",
		async () => {
			const { runtime } = await openRuntime();
			try {
				const bot = await runtime.createBot({ name: "tmp", job: "", avatar: "helper" });
				let offered = "";
				const letter = "您好，我是趙映翔，想應徵 AI 應用工程師。";
				await turn(runtime, bot, [
					(context: TranscriptContext) => {
						offered = JSON.stringify(context);
						return fauxAssistantMessage(fauxToolCall("ask_user", { question: "照這版送出嗎？", options: ["送出", "我要再改"], shows: letter }, { id: "ask-2" }), { stopReason: "toolUse" });
					},
				]);
				assert.match(offered, /"shows"/, "ask_user offers a place for the text being approved");
				assert.match(offered, /is not visible to them/, "the model is told a file it wrote is not what the user sees");
				assert.equal(Value.Check(AskArgs, { question: "照這版送出嗎？", options: ["送出", "我要再改"], shows: letter }), true, "the card accepts a question with the text");
			} finally {
				await runtime.close();
			}
		},
	],
	[
		"an .html the bot wrote is one card with its title and summary, on the latest write or edit of that file",
		async () => {
			const { runtime } = await openRuntime();
			try {
				const bot = await runtime.createBot({ name: "tmp", job: "", avatar: "helper" });
				const content = '<title>比較表</title><meta name="description" content="三個工具">';
				await turn(runtime, bot, [
					fauxAssistantMessage([fauxToolCall("write", { path: "a.html", content }, { id: "w1" }), fauxToolCall("write", { path: "notes.txt", content: "x" }, { id: "w2" })], { stopReason: "toolUse" }),
					fauxAssistantMessage(fauxToolCall("edit", { path: "a.html", edits: [] }, { id: "e1" }), { stopReason: "toolUse" }),
					fauxAssistantMessage("好了"),
				]);
				const entries = await entriesOf(runtime, bot);
				assert.deepEqual([...pageCards(entries, () => true)], [["e1", { path: "a.html", title: "比較表", summary: "三個工具" }]]);
				assert.deepEqual([...pageCards(entries, (id) => id === "w1")], [["w1", { path: "a.html", title: "比較表", summary: "三個工具", html: content }]], "a failed edit keeps the card on the write");
			} finally {
				await runtime.close();
			}
		},
	],
	[
		"asking a place's weather twice in one step keeps one card, and only the latest results are kept",
		async () => {
			const card = (step: string, place: string): ResultCard => ({ kind: "weather", step, place, at: 0, now: { condition: "晴", temperature_c: 20, feels_c: 20 }, hours: [], days: [] });
			const cards: ResultCard[] = [];
			addResult(cards, card("s1", "台北"));
			addResult(cards, card("s1", "台北"));
			addResult(cards, card("s1", "宜蘭"));
			assert.deepEqual(cards.map((kept) => (kept.kind === "weather" ? kept.place : "")), ["台北", "宜蘭"]);
			for (let n = 0; n < 30; n++) addResult(cards, card(`s${n + 2}`, "台北"));
			assert.equal(cards.length, 20);
		},
	],
];
