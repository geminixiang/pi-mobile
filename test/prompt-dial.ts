import assert from "node:assert/strict";
import { type DialState, repeatingOf } from "../src/app/dialState.ts";

const dial = (slot: number): DialState => ({ px: 0, py: 0, radius: 100, start: 160, step: 12, slots: 5, slot, shift: 0, lineY: 0 });
assert.equal(repeatingOf(undefined), undefined);
assert.equal(repeatingOf(dial(0)), undefined);
assert.equal(repeatingOf(dial(4)), undefined);
assert.equal(repeatingOf(dial(5)), "older");
assert.equal(repeatingOf(dial(-1)), "newer");
console.log("prompt dial: repeats only from an open dial's caps");
