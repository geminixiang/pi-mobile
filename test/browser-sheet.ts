import assert from "node:assert/strict";
import { SHEET_START, type SheetEvent, type SheetInputs, sheetAfter, type SheetState } from "../src/browser/sheetState.ts";

const after = (...events: SheetEvent[]): SheetState => events.reduce(sheetAfter, SHEET_START);
const idle: SheetInputs = { bot: "a", handover: undefined, asking: false, openKey: 0 };
const seen = (inputs: Partial<SheetInputs>): SheetEvent => ({ type: "inputs", inputs: { ...idle, ...inputs } });

assert.equal(after(seen({})).mode, "closed");
assert.equal(after(seen({ handover: "登入" })).mode, "handover", "handing over is the one time the sheet opens by itself");
assert.equal(after(seen({ handover: "登入" }), seen({})).mode, "closed", "a sheet the hand-over opened closes with it");
assert.equal(after(seen({ handover: "登入" }), { type: "settled", open: false }).mode, "closed");
assert.equal(after(seen({ openKey: 1 }), seen({ openKey: 1, handover: "登入" }), seen({ openKey: 1 })).mode, "open", "a sheet the user opened stays until they close it");
assert.equal(after(seen({ openKey: 1 }), seen({ openKey: 1, asking: true })).mode, "closed", "a question is never covered, even by a sheet the user opened");
assert.equal(after(seen({ asking: true }), seen({ asking: true, openKey: 1 })).mode, "open", "a question already open does not stop the user looking");

assert.equal(after(seen({ openKey: 1 }), seen({ bot: "b", openKey: 1 })).mode, "closed", "switching Bots does not reopen what the last Bot opened");
assert.equal(after(seen({ openKey: 1 }), seen({ bot: "b", openKey: 1 }), seen({ bot: "a", openKey: 1 })).mode, "closed");
assert.equal(after(seen({ bot: undefined, openKey: 1 })).mode, "closed");

const busy = after(seen({ openKey: 1 }), { type: "strip_toggled" }, { type: "shot", jpeg: "x" }, { type: "failed", message: "no network" });
assert.deepEqual(busy, { ...SHEET_START, mode: "open", strip: true, shot: "x", problem: "no network", inputs: { ...idle, openKey: 1 } });
assert.equal(sheetAfter(busy, { type: "retried" }).problem, "");
assert.deepEqual(sheetAfter(busy, seen({ bot: "b", openKey: 1 })), { ...SHEET_START, inputs: { ...idle, bot: "b", openKey: 1 } });

const page = { bot: "a", tab: "1", url: "https://example.com/", title: "Example", loading: false, canGoBack: true, canGoForward: false };
const list = { bot: "a", tabs: [{ id: "1", url: page.url, title: page.title }], active: "1" };
const kept = after(seen({}), { type: "page", page }, { type: "tabs", list }, seen({ bot: "b" }));
assert.deepEqual(kept.pages, { "a/1": page });
assert.deepEqual(kept.tabs, { a: list });

console.log("browser sheet: only a hand-over opens it by itself, a question closes it, and switching Bots starts over but keeps what each Bot's browser shows");
