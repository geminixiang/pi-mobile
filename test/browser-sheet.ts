import assert from "node:assert/strict";
import { SHEET_START, type SheetEvent, sheetAfter, type SheetState } from "../src/browser/sheetState.ts";

const after = (...events: SheetEvent[]): SheetState => events.reduce(sheetAfter, SHEET_START);

assert.equal(after({ type: "agent_started" }).mode, "auto");
assert.equal(after({ type: "agent_started" }, { type: "agent_finished" }).mode, "closed");
assert.equal(after({ type: "agent_started" }, { type: "settled", open: true }, { type: "agent_finished" }).mode, "open");
assert.equal(after({ type: "user_opened" }, { type: "agent_finished" }).mode, "open");
assert.equal(after({ type: "user_opened" }, { type: "agent_started" }, { type: "agent_finished" }).mode, "closed");
assert.equal(after({ type: "handover" }).mode, "open");
assert.equal(after({ type: "agent_started" }, { type: "handover" }).mode, "auto");
assert.equal(after({ type: "agent_started" }, { type: "settled", open: false }).mode, "closed");
assert.equal(after({ type: "agent_finished" }).mode, "closed");

const busy = after({ type: "user_opened" }, { type: "strip_toggled" }, { type: "shot", jpeg: "x" }, { type: "failed", message: "no network" });
assert.deepEqual(busy, { mode: "open", strip: true, shot: "x", problem: "no network" });
assert.equal(sheetAfter(busy, { type: "retried" }).problem, "");
assert.deepEqual(sheetAfter(busy, { type: "bot_changed" }), SHEET_START);

console.log("browser sheet: who opened it decides whether it closes itself, and switching Bots starts over");
