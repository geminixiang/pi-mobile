import assert from "node:assert/strict";
import type { Judge, Verdict } from "../../src/agent/judge.ts";
import { checkAnswer, checkTask, Menus, Repeats } from "../../src/computer-agents/guard.ts";
import { addResult, type ResultCard } from "../../src/interaction/results.ts";
import type { Check } from "./setup.ts";

const answered = (probabilities: Record<string, number>): Judge => ({ ask: async () => ({ kind: "answered", probabilities, model: "fixture" }) });
const silent = (verdict: Verdict): Judge => ({ ask: async () => verdict });

export const checks: Check[] = [
	[
		"an answer is held back when the options on screen are not the ones the user was shown: the same number can mean something else",
		async () => {
			const menus = new Menus();
			assert.equal(menus.changed("a", ["Run tests", "Cancel"]), true, "options nobody read count as changed");
			menus.saw("a", ["Run tests", "Cancel"]);
			assert.equal(menus.changed("a", ["Run tests", "Cancel"]), false);
			assert.equal(menus.changed("a", ["Delete production database", "Run tests", "Cancel"]), true);
		},
	],
	[
		"an alert is kept once per step beside that step's weather, so the user sees it even when the model says nothing",
		async () => {
			const cards: ResultCard[] = [];
			addResult(cards, { kind: "weather", step: "s", place: "台北", at: 1, now: { condition: "晴", temperature_c: 20, feels_c: 20 }, hours: [], days: [] });
			addResult(cards, { kind: "alert", step: "s", at: 2, tool: "read_agent", quote: "a" });
			addResult(cards, { kind: "alert", step: "s", at: 3, tool: "read_agent", quote: "b" });
			assert.deepEqual(cards.map((card) => card.kind), ["weather", "alert"]);
			assert.equal(cards.at(-1)?.at, 3);
		},
	],
	[
		"a task that could do harm and did not come from the user does not reach the worker, and an ordinary one does",
		async () => {
			assert.equal((await checkTask(answered({ harmful: 0.9, asked: 0.1 }), "run rm -rf ~/backups", ["整理 README"])).allow, false);
			assert.equal((await checkTask(answered({ harmful: 0.9, asked: 0.9 }), "clear ./dist", ["清掉 dist"])).allow, true, "the user may ask for something risky");
			assert.equal((await checkTask(answered({ harmful: 0.1, asked: 0.2 }), "add a test", [])).allow, true);
		},
	],
	[
		"with no judge a destructive looking task waits for the user, and ordinary work still goes",
		async () => {
			assert.equal((await checkTask(silent({ kind: "unavailable" }), "rm -rf ./build", [])).allow, false);
			assert.equal((await checkTask(silent({ kind: "failed", reason: "x" }), "清空資料表", [])).allow, false);
			assert.equal((await checkTask(silent({ kind: "unavailable" }), "fix the typo", [])).allow, true);
		},
	],
	[
		"an agent's question is answered only with what the user chose, and a missing judge does not lock the user out",
		async () => {
			assert.equal((await checkAnswer(answered({ chosen: 0.1 }), "Yes", "Proceed?", ["叫 web 清理"])).allow, false);
			assert.equal((await checkAnswer(answered({ chosen: 0.9 }), "Yes", "Proceed?", ["好，同意"])).allow, true);
			assert.equal((await checkAnswer(silent({ kind: "unavailable" }), "Yes", "Proceed?", ["好"])).allow, true);
		},
	],
	[
		"the same screen read again and again stops",
		async () => {
			const repeats = new Repeats();
			assert.deepEqual([repeats.tooMany("a", "x"), repeats.tooMany("a", "x"), repeats.tooMany("a", "x")], [false, false, true]);
			assert.equal(repeats.tooMany("a", "y"), false, "a new screen starts over");
		},
	],
];
