import assert from "node:assert/strict";
import { stepOf } from "../src/browser/tool.ts";

assert.deepEqual(stepOf({ action: "open" }), { ok: false, problem: "open needs url" });
assert.deepEqual(stepOf({ action: "tap_at", x: 10 }), { ok: false, problem: "tap_at needs x and y" });
assert.deepEqual(stepOf({ action: "type", index: 3, text: "牙醫" }), { ok: true, value: { action: "type", index: 3, text: "牙醫" } });
assert.deepEqual(stepOf({ action: "key", keys: "enter" }), { ok: true, value: { action: "key", key: "enter" } });
assert.deepEqual(stepOf({ action: "key", keys: "f5" }), { ok: false, problem: "keys is enter, tab, escape, or backspace" });
assert.deepEqual(stepOf({ action: "scroll" }), { ok: true, value: { action: "scroll", direction: "down" } });
assert.deepEqual(stepOf({ action: "scroll_in", direction: "left" }), { ok: false, problem: "scroll_in needs index" });
assert.deepEqual(stepOf({ action: "wait" }), { ok: true, value: { action: "wait", ms: 1000 } });
assert.deepEqual(stepOf({ action: "wait", ms: 60_000 }), { ok: true, value: { action: "wait", ms: 10_000 } });
assert.deepEqual(stepOf({ action: "wait_for", text: "結果" }), { ok: true, value: { action: "wait_for", text: "結果", gone: false, ms: 8000 } });
assert.deepEqual(stepOf({ action: "wait_for", text: "載入中", gone: true, ms: 60_000 }), { ok: true, value: { action: "wait_for", text: "載入中", gone: true, ms: 20_000 } });
assert.deepEqual(stepOf({ action: "back" }), { ok: true, value: { action: "back" } });
assert.deepEqual(stepOf({ action: "close_tab" }), { ok: false, problem: "must be the last step" });

console.log("browser steps: a step names only the fields its action uses, with defaults and limits filled in");
