import assert from "node:assert/strict";
import { stepOf } from "../src/phone-screen/tool.ts";

assert.deepEqual(stepOf({ action: "tap", x: 10 }), { ok: false, problem: "tap needs x and y" });
assert.deepEqual(stepOf({ action: "long_press", x: 10, y: 20 }), { ok: true, value: { action: "long_press", x: 10, y: 20 } });
assert.deepEqual(stepOf({ action: "swipe", x: 1, y: 2, to_x: 3 }), { ok: false, problem: "swipe needs x, y, to_x and to_y" });
assert.deepEqual(stepOf({ action: "swipe", x: 1, y: 2, to_x: 3, to_y: 4 }), { ok: true, value: { action: "swipe", x: 1, y: 2, to_x: 3, to_y: 4, ms: 300 } });
assert.deepEqual(stepOf({ action: "swipe", x: 1, y: 2, to_x: 3, to_y: 4, ms: 9000 }), { ok: true, value: { action: "swipe", x: 1, y: 2, to_x: 3, to_y: 4, ms: 5000 } });
assert.deepEqual(stepOf({ action: "scroll" }), { ok: true, value: { action: "scroll", direction: "down" } });
assert.deepEqual(stepOf({ action: "scroll", direction: "left", y: 300 }), { ok: true, value: { action: "scroll", direction: "left", y: 300 } });
assert.deepEqual(stepOf({ action: "type" }), { ok: false, problem: "type needs text" });
assert.deepEqual(stepOf({ action: "key", keys: "home" }), { ok: true, value: { action: "key", key: "home" } });
assert.deepEqual(stepOf({ action: "key", keys: "volume_up" }), { ok: false, problem: "keys is back, home, recents, notifications, quick_settings, or enter" });
assert.deepEqual(stepOf({ action: "open", app: "  " }), { ok: false, problem: "open needs app" });
assert.deepEqual(stepOf({ action: "wait" }), { ok: true, value: { action: "wait", ms: 500 } });
assert.deepEqual(stepOf({ action: "wait", ms: 60_000 }), { ok: true, value: { action: "wait", ms: 10_000 } });

console.log("phone screen steps: a step names only the fields its action uses, with defaults and limits filled in");
