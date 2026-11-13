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
// why: as above
const user = (): EntryRecord => ({ id: ++id, kind: "pi.user", model: [{ role: "user", content: "好", timestamp: 0 }] }) as unknown as EntryRecord;

const write = (callId: string, path: string, content = "") => [assistant([{ name: "write", args: { path, content }, id: callId }]), result(callId, "ok")];
const ask = (callId: string) => assistant([{ name: "ask_user", args: { question: "寄出嗎？", options: ["寄", "先不要"] }, id: callId }]);
const form = (conversationId: ConversationId): PendingForm => ({ conversationId, service: "Gmail", request: { message: "寄給 Tina", schema: { type: "object", properties: {} } }, confirm: "核准寄出" });
const todo = (bot: ConversationId): Item => ({ id: "i1", title: "回覆房東", bot, state: "todo", createdAt: 0, updatedAt: 0 });
const daily: Trigger = { id: "t1", name: "求職廣域掃描", prompt: "scan", when: { kind: "daily", time: "09:00", days: [] }, conversationId: BOT, state: "on", createdAt: 0, kind: "schedule" };
const watch: Trigger = { id: "w1", name: "等「go test ./...」跑完", prompt: "", when: { kind: "once", at: 1 }, conversationId: BOT, state: "on", createdAt: 20_000, kind: "watch", agent: "job:0123abcd" };

const quiet: Sources = { bot: BOT, entries: [], tools: [], forms: new Map(), items: [], triggers: [], next: {}, browser: { active: false, handover: undefined } };
const open = (key: string) => benchStep(emptyBench(String(BOT)), { type: "show", bot: String(BOT), key });

const result = (callId: string, text: string, isError = false): EntryRecord => {
	// why: as above
	return { id: ++id, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: callId, toolName: "tool", content: [{ type: "text", text }], isError, timestamp: 0 }] } as unknown as EntryRecord;
};
// why: as above
const answer = (text: string): EntryRecord => ({ id: ++id, kind: "pi.assistant", model: [fauxAssistantMessage(text)] }) as unknown as EntryRecord;

export const checks: Check[] = [
	[
		"the stage takes what needs the user, then what moves, then the opened file, then the last result",
		async () => {
			const written = { ...quiet, entries: write("w", "職缺比較.html") };
			assert.equal(boardOf(quiet, emptyBench(String(BOT))).stage, undefined);
			assert.equal(boardOf(written, emptyBench(String(BOT))).stage?.key, fileKey("職缺比較.html"), "idle: the last result, to go on working on");
			const two = { ...quiet, entries: [...write("w", "職缺比較.html"), ...write("v", "履歷.md")] };
			const opened = benchStep(benchStep(open(fileKey("職缺比較.html")), { type: "show", bot: String(BOT), key: "agent:job:0123abcd" }), { type: "close", bot: String(BOT), key: "agent:job:0123abcd" });
			assert.equal(boardOf(two, opened).stage?.key, fileKey("職缺比較.html"), "a file the user opened comes before a newer result");
			const moving = { ...two, triggers: [watch] };
			assert.equal(boardOf(moving, opened).stage?.key, "agent:job:0123abcd", "a job on the computer comes before the opened file");
			const needed = { ...moving, forms: new Map([["c1", form(BOT)]]) };
			assert.equal(boardOf(needed, opened).stage?.key, "form:c1", "what needs the user comes first");
			assert.equal(boardOf(needed, opened).pinned, false);
		},
	],
	[
		"a thing the user opened stays on stage when a new need arrives, and the need lights up in the tray",
		async () => {
			const bench = open(fileKey("職缺比較.html"));
			const after = boardOf({ ...quiet, entries: [...write("w", "職缺比較.html"), user(), ask("q1")], items: [todo(BOT)], forms: new Map([["c1", form(BOT)]]) }, bench);
			assert.equal(after.stage?.key, fileKey("職缺比較.html"));
			assert.equal(after.pinned, true);
			assert.equal(after.queue, undefined, "a file on stage is not in the queue");
			assert.deepEqual(after.tray.find((section) => section.group === "need")?.cards.map((card) => card.key), ["form:c1", "ask:q1", "item:i1"]);
			assert.equal(boardOf({ ...quiet, forms: new Map([["c1", form(BOT)]]) }, open(FOLDER)).stage?.kind, "folder", "the folder the user opened stays too");
			const asked = boardOf({ ...quiet, entries: [...write("w", "職缺比較.html"), ask("q1")], forms: new Map([["c1", form(BOT)]]) }, bench);
			assert.equal(asked.stage?.key, "ask:q1", "when the bot asks about the opened file, the file stays on stage with the answer under it");
			assert.equal(asked.pinned, true);
		},
	],
	[
		"the needs are a queue: acting on the one on stage brings up the next",
		async () => {
			const both = { ...quiet, entries: [ask("q1")], forms: new Map([["c1", form(BOT)]]) };
			const first = boardOf(both, emptyBench(String(BOT)));
			assert.equal(first.stage?.key, "form:c1");
			assert.deepEqual(first.queue, { at: 1, total: 2 });
			const answered = boardOf({ ...both, forms: new Map() }, emptyBench(String(BOT)));
			assert.equal(answered.stage?.key, "ask:q1");
			assert.deepEqual(answered.queue, { at: 1, total: 1 });
			const picked = boardOf({ ...both, entries: [ask("q1"), user()] }, open("ask:q1"));
			assert.equal(picked.stage?.key, "form:c1", "a picked question that was answered brings up the next need");
		},
	],
	[
		"a question asked right after a draft carries that draft, so the answer and what it is about share the stage",
		async () => {
			const entries = [user(), ...write("d", "給精藤的求職信.md"), ...write("e", "給精藤的求職信.md"), ask("q1")];
			const board = boardOf({ ...quiet, entries }, emptyBench(String(BOT)));
			assert.ok(board.stage?.kind === "ask");
			assert.deepEqual(board.stage.draft, { path: "給精藤的求職信.md", version: 2, previous: "" });
			assert.deepEqual(board.stage.options, ["寄", "先不要"]);
			const earlier = boardOf({ ...quiet, entries: [...write("d", "舊.md"), user(), ask("q1")] }, emptyBench(String(BOT)));
			assert.ok(earlier.stage?.kind === "ask");
			assert.equal(earlier.stage.draft, undefined, "a file from an earlier turn is not the draft");
		},
	],
	[
		"each written file is one result, newest first; a failed write is none, and every write counts toward its version",
		async () => {
			const entries = [...write("a", "a.html", "<title>本週職缺比較</title>"), ...write("b", "b.md"), ...write("c", "a.html"), assistant([{ name: "write", args: { path: "c.md" }, id: "d" }]), result("d", "no", true)];
			const results = boardOf({ ...quiet, entries }, emptyBench(String(BOT))).tray.find((section) => section.group === "result")?.cards ?? [];
			assert.deepEqual(results.map((card) => card.key), [fileKey("a.html"), fileKey("b.md")]);
			const page = results[0];
			assert.ok(page?.kind === "file");
			assert.equal(page.title, "本週職缺比較");
			assert.equal(page.version, 2, "an answer that rewrites the file changes its version, so the stage reloads it");
		},
	],
	[
		"the pages this turn read are its sources, with what was read and the title the answer gave them",
		async () => {
			const entries = [
				user(),
				assistant([{ name: "web_fetch", args: { url: "https://jingteng.tw/jobs/42" }, id: "f" }]),
				result("f", "平台暨後端工程師 年薪 140–170 萬"),
				assistant([{ name: "web_search", args: { query: "精藤 薪水" }, id: "s" }]),
				result("s", "精藤薪水不錯\n\nSources:\n- 精藤 104: https://104.com.tw/company/1"),
				answer("年薪 140–170 萬（[精藤職缺](https://jingteng.tw/jobs/42)）。"),
			];
			const board = boardOf({ ...quiet, entries }, emptyBench(String(BOT)));
			assert.ok(board.stage?.kind === "sources");
			assert.deepEqual(board.stage.sources.map(({ url, title }) => ({ url, title })), [
				{ url: "https://jingteng.tw/jobs/42", title: "精藤職缺" },
				{ url: "https://104.com.tw/company/1", title: "精藤 104" },
			]);
			assert.equal(board.stage.sources[0]?.read, "平台暨後端工程師 年薪 140–170 萬");
			const later = boardOf({ ...quiet, entries: [...entries, user(), answer("好")] }, emptyBench(String(BOT)));
			assert.equal(later.stage, undefined, "only the latest turn's sources");
		},
	],
	[
		"a file a schedule keeps rewriting is the bot's living board: on stage when idle, ahead of newer results, with the version before the last run to mark what changed",
		async () => {
			// why: a scheduled run starts its turn with this entry; the board reads only its kind and data
			const run = (at: number): EntryRecord => ({ id: ++id, kind: "trigger.run", data: { trigger: "t1", name: "0050 盯盤", prompt: "p", kind: "schedule", delivery: "live", at } }) as unknown as EntryRecord;
			const entries = [run(1), ...write("a", "0050看板.html", "<p>198.35</p>"), run(2), ...write("b", "0050看板.html", "<p>196.80</p>"), user(), ...write("c", "筆記.md")];
			const board = boardOf({ ...quiet, entries }, emptyBench(String(BOT)));
			assert.ok(board.stage?.kind === "file");
			assert.equal(board.stage.path, "0050看板.html");
			assert.deepEqual(board.stage.living, { schedule: "0050 盯盤", at: 2 });
			assert.equal(board.stage.previous, "<p>198.35</p>", "the last run's change is marked even after the app restarted");
			const results = board.tray.find((section) => section.group === "result")?.cards.map((card) => card.key);
			assert.deepEqual(results, [fileKey("0050看板.html"), fileKey("筆記.md")]);
			const notes = boardOf({ ...quiet, entries: [user(), ...write("c", "筆記.md")] }, emptyBench(String(BOT))).stage;
			assert.ok(notes?.kind === "file");
			assert.equal(notes.living, undefined, "a file written because the user asked is not a board");
		},
	],
	[
		"schedules are one quiet line, never a card: the soonest of this bot's runs and items",
		async () => {
			const waiting: Item = { id: "i3", title: "等 Tina 回信", bot: BOT, state: "waiting", waitingOn: "Tina", nextAt: 5, createdAt: 0, updatedAt: 0 };
			const board = boardOf({ ...quiet, triggers: [daily, { ...daily, id: "t2", state: "paused" as const }], next: { t1: 9, t2: 1 }, items: [waiting] }, emptyBench(String(BOT)));
			assert.deepEqual(board.next, { name: "等 Tina 回信", at: 5 });
			assert.deepEqual(board.tray, []);
			assert.equal(board.stage, undefined);
			assert.equal(boardOf({ ...quiet, triggers: [{ ...daily, conversationId: OTHER }], next: { t1: 9 } }, emptyBench(String(BOT))).next, undefined, "another bot's schedule is not this one's");
		},
	],
	[
		"only this bot's forms and items show; a done item does not",
		async () => {
			const others = { ...quiet, forms: new Map([["c2", form(OTHER)]]), items: [todo(OTHER), { ...todo(BOT), id: "i2", state: "done" as const, doneAt: 1 }] };
			assert.deepEqual(boardOf(others, emptyBench(String(BOT))).tray, []);
		},
	],
	[
		"the tools of the live turn move, and a browser handed over to the user needs them",
		async () => {
			const entries = [assistant([{ name: "bash", args: { command: "npm test" }, id: "b1" }])];
			const busy = boardOf({ ...quiet, entries, tools: [{ callId: "b1", name: "bash", status: "running", output: "ok 3" }] }, emptyBench(String(BOT)));
			assert.ok(busy.stage?.kind === "turn");
			assert.equal(busy.stage.steps[0]?.call?.arguments.command, "npm test");
			const handover = boardOf({ ...quiet, browser: { active: true, handover: "登入 104" } }, emptyBench(String(BOT)));
			assert.equal(handover.stage?.key, "browser");
			assert.equal(handover.tray[0]?.group, "need");
		},
	],
];
