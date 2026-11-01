import assert from "node:assert/strict";
import { agenda, type Item, schedulesOf } from "../src/items/items.ts";

const bots = [
	{ id: 1, name: "財務管家", avatar: "money" },
	{ id: 2, name: "求職管家", avatar: "job" },
];
const at = (hours: number) => Date.UTC(2026, 10, 1, hours);
const item = (title: string, bot: number, state: Item["state"], nextAt?: number) => ({ title, bot, state, ...(nextAt !== undefined ? { nextAt } : {}) });
const endOfDay = at(24);

assert.deepEqual(
	agenda([item("later", 1, "todo", at(30)), item("undated", 2, "todo"), item("due", 1, "todo", at(9)), item("overdue", 2, "todo", at(1))], bots, endOfDay).map((due) => due.title),
	["overdue", "due", "undated"],
);
assert.deepEqual(agenda([item("waiting", 1, "waiting", at(9)), item("done", 1, "done"), item("orphan", 9, "todo")], bots, endOfDay), []);
assert.deepEqual(agenda([item("due", 2, "todo", at(9))], bots, endOfDay), [{ conversation: "2", bot: "求職管家", avatar: "job", title: "due", due: at(9) }]);

const stored = { id: "i1", title: "等王經理回信", bot: 1, createdAt: 0, updatedAt: 0 };
assert.deepEqual(
	schedulesOf({ ...stored, state: "waiting", waitingOn: "王經理", wake: { app: "Gmail", contains: "王" }, nextAt: at(9) }, "job").map((schedule) => [schedule.id, schedule.when]),
	[
		["item:i1", { kind: "once", at: at(9) }],
		["reply:i1", { kind: "notification", app: "Gmail", contains: "王", days: [], gapHours: 1 }],
	],
);
assert.deepEqual(schedulesOf({ ...stored, state: "done", doneAt: 0, nextAt: at(9) }, "job"), []);
assert.deepEqual(schedulesOf({ ...stored, state: "todo" }, undefined), []);

console.log("items: an item's next time is an alarm and a waited-for reply is a notification watch; the widget's agenda is the user's todo items due by the end of today, then undated ones, each with its bot");
