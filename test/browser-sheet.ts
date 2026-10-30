import assert from "node:assert/strict";
import { SHEET_START, type SheetEvent, type SheetInputs, sheetAfter, type SheetState } from "../src/browser/sheetState.ts";

const after = (...events: SheetEvent[]): SheetState => events.reduce(sheetAfter, SHEET_START);
const idle: SheetInputs = { bot: "a", active: false, handover: undefined, openKey: 0 };
const seen = (inputs: Partial<SheetInputs>): SheetEvent => ({ type: "inputs", inputs: { ...idle, ...inputs } });

assert.equal(after(seen({})).mode, "closed");
assert.equal(after(seen({ active: true })).mode, "auto");
assert.equal(after(seen({ active: true }), seen({}), { type: "agent_finished" }).mode, "closed");
assert.equal(after(seen({ active: true }), { type: "settled", open: true }, { type: "agent_finished" }).mode, "open");
assert.equal(after(seen({ openKey: 1 }), { type: "agent_finished" }).mode, "open");
assert.equal(after(seen({ openKey: 1 }), seen({ openKey: 1, active: true }), { type: "agent_finished" }).mode, "closed");
assert.equal(after(seen({ handover: "登入" })).mode, "open");
assert.equal(after(seen({ active: true }), seen({ active: true, handover: "登入" })).mode, "auto");
assert.equal(after(seen({ active: true }), { type: "settled", open: false }).mode, "closed");
assert.equal(after({ type: "agent_finished" }).mode, "closed");

assert.equal(after(seen({ openKey: 1 }), seen({ bot: "b", openKey: 1 })).mode, "closed", "switching Bots does not reopen what the last Bot opened");
assert.equal(after(seen({ openKey: 1 }), seen({ bot: "b", openKey: 1 }), seen({ bot: "a", openKey: 1 })).mode, "closed");
assert.equal(after(seen({ bot: undefined, openKey: 1 })).mode, "closed");
assert.equal(after(seen({ bot: "b", active: true }), seen({ active: true })).mode, "closed", "a Bot already at work when switched to is not opened");
assert.equal(after(seen({}), seen({ bot: "b", active: true })).mode, "auto");

const busy = after(seen({ openKey: 1 }), { type: "strip_toggled" }, { type: "shot", jpeg: "x" }, { type: "failed", message: "no network" });
assert.deepEqual(busy, { ...SHEET_START, mode: "open", strip: true, shot: "x", problem: "no network", inputs: { ...idle, openKey: 1 } });
assert.equal(sheetAfter(busy, { type: "retried" }).problem, "");
assert.deepEqual(sheetAfter(busy, seen({ bot: "b", openKey: 1 })), { ...SHEET_START, inputs: { ...idle, bot: "b", openKey: 1 } });

const page = { bot: "a", tab: "1", url: "https://example.com/", title: "Example", loading: false, canGoBack: true, canGoForward: false };
const list = { bot: "a", tabs: [{ id: "1", url: page.url, title: page.title }], active: "1" };
const kept = after(seen({}), { type: "page", page }, { type: "tabs", list }, seen({ bot: "b" }));
assert.deepEqual(kept.pages, { "a/1": page });
assert.deepEqual(kept.tabs, { a: list });

console.log("browser sheet: who opened it decides whether it closes itself, and switching Bots starts over but keeps what each Bot's browser shows");
