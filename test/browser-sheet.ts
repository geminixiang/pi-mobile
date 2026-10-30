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
assert.deepEqual(busy, { ...SHEET_START, mode: "open", strip: true, shot: "x", problem: "no network" });
assert.equal(sheetAfter(busy, { type: "retried" }).problem, "");
assert.deepEqual(sheetAfter(busy, { type: "bot_changed" }), SHEET_START);

const page = { bot: "a", tab: "1", url: "https://example.com/", title: "Example", loading: false, canGoBack: true, canGoForward: false };
const list = { bot: "a", tabs: [{ id: "1", url: page.url, title: page.title }], active: "1" };
const seen = after({ type: "page", page }, { type: "tabs", list }, { type: "user_opened" }, { type: "bot_changed" });
assert.deepEqual(seen, { ...SHEET_START, pages: { "a/1": page }, tabs: { a: list } });

console.log("browser sheet: who opened it decides whether it closes itself, and switching Bots starts over but keeps what each Bot's browser shows");
