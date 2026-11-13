import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ConversationId, EntryRecord } from "@earendil-works/pi-durable";
import type { PendingForm } from "../../src/interaction/forms.ts";
import type { Item } from "../../src/items/items.ts";
import type { Trigger } from "../../src/triggers/runs.ts";
import { benchStep, emptyBench, FOLDER, fileKey } from "../../src/workbench/bench.ts";
import { boardOf, type Sources } from "../../src/workbench/board.ts";
import type { Check } from "./setup.ts";

// why: a conversation id is a branded number in pi-durable; the board only compares it
const BOT = 1 as unknown as ConversationId;
// why: as above
const OTHER = 2 as unknown as ConversationId;

let id = 0;
const assistant = (calls: { name: string; args: Record<string, string | string[]>; id: string }[]): EntryRecord => {
	// why: the board reads only kind and the model message; the rest of a stored entry is not what this check is about
	return { id: ++id, kind: "pi.assistant", model: [fauxAssistantMessage(calls.map((call) => fauxToolCall(call.name, call.args, { id: call.id })))] } as unknown as EntryRecord;
};
const result = (callId: string, isError = false): EntryRecord => {
	// why: as above
	return { id: ++id, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: callId, toolName: "write", content: [], isError, timestamp: 0 }] } as unknown as EntryRecord;
};
// why: as above
const user = (): EntryRecord => ({ id: ++id, kind: "pi.user", model: [{ role: "user", content: "好", timestamp: 0 }] }) as unknown as EntryRecord;

const write = (callId: string, path: string, content = "") => [assistant([{ name: "write", args: { path, content }, id: callId }]), result(callId)];
const ask = (callId: string) => assistant([{ name: "ask_user", args: { question: "寄出嗎？", options: ["寄", "先不要"] }, id: callId }]);
const form = (conversationId: ConversationId): PendingForm => ({ conversationId, service: "Gmail", request: { message: "寄給 Tina", schema: { type: "object", properties: {} } }, confirm: "核准寄出" });
const todo = (bot: ConversationId): Item => ({ id: "i1", title: "回覆房東", bot, state: "todo", createdAt: 0, updatedAt: 0 });
const daily: Trigger = { id: "t1", name: "求職廣域掃描", prompt: "scan", when: { kind: "daily", time: "09:00", days: [] }, conversationId: BOT, state: "on", createdAt: 0, kind: "schedule" };
const watch: Trigger = { id: "w1", name: "等「go test ./...」跑完", prompt: "", when: { kind: "once", at: 1 }, conversationId: BOT, state: "on", createdAt: 20_000, kind: "watch", agent: "job:0123abcd" };

const quiet: Sources = { bot: BOT, entries: [], tools: [], forms: new Map(), items: [], triggers: [], next: {}, browser: { active: false, handover: undefined } };
const open = (key: string) => benchStep(emptyBench(String(BOT)), { type: "show", bot: String(BOT), key });

export const checks: Check[] = [
	[
		"the stage takes what needs the user, then what moves, then the opened file, then the next scheduled run, then the last result",
		async () => {
			const written = { ...quiet, entries: write("w", "職缺比較.html") };
			assert.equal(boardOf(quiet, emptyBench(String(BOT))).stage, undefined);
			assert.equal(boardOf(written, emptyBench(String(BOT))).stage?.key, fileKey("職缺比較.html"), "idle with no schedule: the last result");
			const scheduled = { ...written, triggers: [daily], next: { t1: 9 } };
			assert.equal(boardOf(scheduled, emptyBench(String(BOT))).stage?.key, "schedule:t1", "idle: the next scheduled run");
			const opened = benchStep(open(fileKey("職缺比較.html")), { type: "show", bot: String(BOT), key: "schedule:t1" });
			const unpicked = benchStep(opened, { type: "close", bot: String(BOT), key: "schedule:t1" });
			assert.equal(boardOf(scheduled, unpicked).stage?.key, fileKey("職缺比較.html"), "a file the user opened comes before the schedule");
			const moving = { ...scheduled, triggers: [daily, watch] };
			assert.equal(boardOf(moving, unpicked).stage?.key, "agent:job:0123abcd", "a job on the computer comes before the opened file");
			const needed = { ...moving, forms: new Map([["c1", form(BOT)]]) };
			assert.equal(boardOf(needed, unpicked).stage?.key, "form:c1", "what needs the user comes first");
			assert.equal(boardOf(needed, unpicked).pinned, false);
		},
	],
	[
		"a thing the user opened stays on stage when a new need arrives, and the need lights up in the tray",
		async () => {
			const bench = open(fileKey("職缺比較.html"));
			const before = boardOf({ ...quiet, entries: write("w", "職缺比較.html") }, bench);
			assert.equal(before.stage?.key, fileKey("職缺比較.html"));
			const after = boardOf({ ...quiet, entries: [...write("w", "職缺比較.html"), ask("q1")], items: [todo(BOT)], forms: new Map([["c1", form(BOT)]]) }, bench);
			assert.equal(after.stage?.key, fileKey("職缺比較.html"));
			assert.equal(after.pinned, true);
			assert.deepEqual(after.tray.find((section) => section.group === "need")?.cards.map((card) => card.key), ["form:c1", "ask:q1", "item:i1"]);
			const folder = boardOf({ ...quiet, forms: new Map([["c1", form(BOT)]]) }, open(FOLDER));
			assert.equal(folder.stage?.kind, "folder", "the folder the user opened stays too");
		},
	],
	[
		"a picked card that is gone gives the stage back to the order",
		async () => {
			const bench = open("ask:q1");
			const asking = { ...quiet, entries: [ask("q1")], triggers: [watch] };
			assert.equal(boardOf(asking, bench).stage?.key, "ask:q1");
			const answered = { ...asking, entries: [ask("q1"), user()] };
			assert.equal(boardOf(answered, bench).stage?.key, "agent:job:0123abcd");
			assert.equal(boardOf(answered, bench).pinned, false);
		},
	],
	[
		"each written file is one result, newest first; a failed write is none, and every write counts toward its version",
		async () => {
			const entries = [...write("a", "a.html", "<title>本週職缺比較</title>"), ...write("b", "b.md"), ...write("c", "a.html"), assistant([{ name: "write", args: { path: "c.md" }, id: "d" }]), result("d", true)];
			const results = boardOf({ ...quiet, entries }, emptyBench(String(BOT))).tray.find((section) => section.group === "result")?.cards ?? [];
			assert.deepEqual(results.map((card) => card.key), [fileKey("a.html"), fileKey("b.md")]);
			const page = results[0];
			assert.ok(page?.kind === "file");
			assert.equal(page.title, "本週職缺比較");
			assert.equal(page.version, 2, "an answer that rewrites the file changes its version, so the stage reloads it");
		},
	],
	[
		"only this bot's forms, items and schedules show; a paused schedule and a done item do not",
		async () => {
			const others = {
				...quiet,
				forms: new Map([["c2", form(OTHER)]]),
				items: [todo(OTHER), { ...todo(BOT), id: "i2", state: "done" as const, doneAt: 1 }],
				triggers: [{ ...daily, conversationId: OTHER }, { ...daily, id: "t2", state: "paused" as const }],
			};
			assert.deepEqual(boardOf(others, emptyBench(String(BOT))).tray, []);
		},
	],
	[
		"the tools of the live turn move, and a browser handed over to the user needs them",
		async () => {
			const entries = [assistant([{ name: "bash", args: { command: "npm test" }, id: "b1" }])];
			const busy = boardOf({ ...quiet, entries, tools: [{ callId: "b1", name: "bash", status: "running", output: "ok 3" }] }, emptyBench(String(BOT)));
			assert.equal(busy.stage?.kind, "turn");
			assert.ok(busy.stage?.kind === "turn");
			assert.equal(busy.stage.steps[0]?.call?.arguments.command, "npm test");
			const handover = boardOf({ ...quiet, browser: { active: true, handover: "登入 104" } }, emptyBench(String(BOT)));
			assert.equal(handover.stage?.key, "browser");
			assert.equal(handover.tray[0]?.group, "need");
		},
	],
];
