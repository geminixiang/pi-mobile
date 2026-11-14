import assert from "node:assert/strict";
import type { Trigger } from "../src/triggers/runs.ts";
import { describeNear, describeRule, grouped } from "../src/triggers/when.ts";

const hour = 60 * 60 * 1000;
const endOfToday = Date.UTC(2026, 10, 3, 16);
const trigger = (id: string, when: Trigger["when"], state: Trigger["state"] = "on") => ({ id, when, state, createdAt: 0 });

const triggers = [
	trigger("tomorrow", { kind: "daily", time: "08:00", days: [] }),
	trigger("tonight", { kind: "daily", time: "21:30", days: [] }),
	trigger("soon", { kind: "once", at: endOfToday - 6 * hour }),
	trigger("headphones", { kind: "headphones", days: [], gapHours: 24 }),
	trigger("paused", { kind: "daily", time: "07:30", days: [1, 3] }, "paused"),
	trigger("ran", { kind: "once", at: endOfToday - 30 * hour }, "fired"),
];
const next = { tomorrow: endOfToday + 8 * hour, tonight: endOfToday - 2 * hour, soon: endOfToday - 6 * hour };

assert.deepEqual(
	grouped(triggers, next, endOfToday).map((section) => [section.label, section.triggers.map((item) => item.id)]),
	[
		["今天", ["soon", "tonight"]],
		["之後", ["tomorrow"]],
		["遇到時", ["headphones"]],
		["暫停", ["paused"]],
		["跑完了", ["ran"]],
	],
);
assert.deepEqual(grouped([], {}, endOfToday), []);
const midnight = new Date(2026, 10, 15).getTime();
const at = (days: number, hours: number) => midnight + days * 86_400_000 + hours * 3_600_000;
assert.equal(describeNear(at(-1, 20), midnight), "昨天 20:00");
assert.equal(describeNear(at(0, 9), midnight), "今天 09:00");
assert.equal(describeNear(at(1, 9), midnight), "明天 09:00");
assert.equal(describeNear(at(3, 20), midnight), "11/18（三）20:00", "a time days ahead is a date, not yesterday");
assert.equal(describeNear(at(-3, 8), midnight), "11/12（四）08:00");
assert.equal(describeRule({ kind: "daily", time: "21:30", days: [] }), "每天");
assert.equal(describeRule({ kind: "daily", time: "08:00", days: [1, 2, 3, 4, 5] }), "平日");
assert.equal(describeRule({ kind: "once", at: endOfToday }), undefined);
assert.equal(describeRule({ kind: "headphones", days: [], gapHours: 24, from: "18:00", until: "22:00" }), "戴上耳機時 · 一天一次");
console.log("trigger groups: automations sort into today, later, events, paused and done, soonest first, empty groups left out; a row's detail names the days or the event, never the time again");
