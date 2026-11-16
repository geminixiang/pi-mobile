import assert from "node:assert/strict";
import { Value } from "typebox/value";
import { PhoneScreenExtension, stepOf } from "../src/phone-screen/tool.ts";

assert.deepEqual(stepOf({ action: "tap", x: 10 }), { ok: false, problem: "tap needs x and y" });
assert.deepEqual(stepOf({ action: "long_press", x: 10, y: 20 }), { ok: true, value: { action: "long_press", x: 10, y: 20 } });
assert.deepEqual(stepOf({ action: "swipe", x: 1, y: 2, to_x: 3 }), { ok: false, problem: "swipe needs x, y, to_x and to_y" });
assert.deepEqual(stepOf({ action: "swipe", x: 1, y: 2, to_x: 3, to_y: 4 }), { ok: true, value: { action: "swipe", x: 1, y: 2, to_x: 3, to_y: 4, ms: 300 } });
assert.deepEqual(stepOf({ action: "swipe", x: 1, y: 2, to_x: 3, to_y: 4, ms: 9000 }), { ok: true, value: { action: "swipe", x: 1, y: 2, to_x: 3, to_y: 4, ms: 5000 } });
assert.deepEqual(stepOf({ action: "scroll" }), { ok: true, value: { action: "scroll", direction: "down" } });
assert.deepEqual(stepOf({ action: "scroll", direction: "left", y: 300 }), { ok: true, value: { action: "scroll", direction: "left", y: 300 } });
assert.deepEqual(stepOf({ action: "type" }), { ok: false, problem: "type needs text" });
assert.deepEqual(stepOf({ action: "type", id: 7, text: "Test" }), { ok: true, value: { action: "type", text: "Test", id: 7 } }, "typing into a field by id needs no tap and no keyboard");
assert.deepEqual(stepOf({ action: "type", id: 0, text: "Test" }), { ok: true, value: { action: "type", text: "Test" } });
assert.deepEqual(stepOf({ action: "key", keys: "home" }), { ok: true, value: { action: "key", key: "home" } });
assert.deepEqual(stepOf({ action: "key", keys: "volume_up" }), { ok: false, problem: "keys is back, home, recents, notifications, quick_settings, or enter" });
assert.deepEqual(stepOf({ action: "open", app: "  " }), { ok: false, problem: "open needs app" });
assert.deepEqual(stepOf({ action: "wait" }), { ok: true, value: { action: "wait", ms: 500 } });
assert.deepEqual(stepOf({ action: "wait", ms: 60_000 }), { ok: true, value: { action: "wait", ms: 10_000 } });

assert.deepEqual(stepOf({ action: "tap", id: 12 }), { ok: true, value: { action: "tap", id: 12 } });
assert.deepEqual(stepOf({ action: "tap", text: "Network & internet" }), { ok: true, value: { action: "tap", text: "Network & internet" } });
assert.deepEqual(stepOf({ action: "tap", x: 0, y: 0 }), { ok: true, value: { action: "tap", x: 0, y: 0 } });
for (const target of [{ id: 1, text: "Settings" }, { id: 1, x: 120, y: 40 }, { text: "Settings", x: 3, y: 9 }]) {
	assert.deepEqual(stepOf({ action: "tap", ...target }), { ok: false, problem: "tap needs one of id, text, or x and y, not several" });
}
assert.deepEqual(stepOf({ action: "tap", id: 83, gone: false, x: 0, y: 0, to_x: 0, to_y: 0, direction: "down", ms: 300, text: "", keys: "", app: "" }), { ok: true, value: { action: "tap", id: 83 } });
assert.deepEqual(stepOf({ action: "tap", text: "Settings", y: 0 }), { ok: true, value: { action: "tap", text: "Settings" } });
const act = PhoneScreenExtension.tools?.find((tool) => tool.name === "phone_act_as_user");
assert.equal(act && Value.Check(act.parameters, { steps: [{ action: "tap", id: 0, text: "Submit order", x: 0, y: 0 }] }), true, "a model that fills every field can say no id with 0");
assert.deepEqual(stepOf({ action: "tap", id: 0, text: "Submit order", x: 0, y: 0 }), { ok: true, value: { action: "tap", text: "Submit order" } });
assert.deepEqual(stepOf({ action: "tap" }), { ok: false, problem: "tap needs x and y" });
assert.deepEqual(stepOf({ action: "tap", text: " " }), { ok: false, problem: "tap needs nonempty text" });
assert.deepEqual(stepOf({ action: "wait_for", text: "Loading" }), { ok: true, value: { action: "wait_for", text: "Loading", gone: false, ms: 3000 } });
assert.deepEqual(stepOf({ action: "wait_for", text: "Loading", gone: true, ms: 90_000 }), { ok: true, value: { action: "wait_for", text: "Loading", gone: true, ms: 10_000 } });
assert.deepEqual(stepOf({ action: "scroll_to", text: "About", direction: "up" }), { ok: true, value: { action: "scroll_to", text: "About", direction: "up" } });
assert.deepEqual(stepOf({ action: "scroll_to", text: "About" }), { ok: true, value: { action: "scroll_to", text: "About", direction: "down" } });
for (const action of ["wait_for", "scroll_to"] as const) {
	assert.deepEqual(stepOf({ action }), { ok: false, problem: `${action} needs text` });
	assert.deepEqual(stepOf({ action, text: " " }), { ok: false, problem: `${action} needs text` });
}
assert.deepEqual(stepOf({ action: "expect" }), { ok: false, problem: "expect needs app or text" });
assert.deepEqual(stepOf({ action: "expect", app: " ", text: " " }), { ok: false, problem: "expect needs app or text" });
assert.deepEqual(stepOf({ action: "expect", app: "Settings", text: "Apps" }), { ok: true, value: { action: "expect", app: "Settings", text: "Apps" } });
assert.deepEqual(stepOf({ action: "expect", text: "Apps" }), { ok: true, value: { action: "expect", text: "Apps" } });

console.log("phone screen steps: live targets, exclusive tap forms, waits, search and expectations with defaults and bounds");
