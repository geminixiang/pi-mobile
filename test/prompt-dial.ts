import assert from "node:assert/strict";
import { type DialState, positionOf, repeatingOf, turned } from "../src/app/dialState.ts";

const dial = (slot: number): DialState => ({ px: 0, py: 0, radius: 100, start: 160, step: 12, slots: 5, slot, shift: 0, lineY: 0 });
assert.equal(repeatingOf(undefined), undefined);
assert.equal(repeatingOf(dial(0)), undefined);
assert.equal(repeatingOf(dial(4)), undefined);
assert.equal(repeatingOf(dial(5)), "older");
assert.equal(repeatingOf(dial(-1)), "newer");

const PROMPTS = 9;
const atOlderCap = dial(5);
const once = turned(atOlderCap, "older", PROMPTS);
assert.deepEqual([once.shift, once.slot], [1, 5], "holding the older cap moves the window one prompt and keeps turning");
assert.equal(positionOf(once, PROMPTS), 4, "the cap shows the prompt that just came into the window");
const toOldest = [1, 2, 3, 4, 5].reduce((state) => turned(state, "older", PROMPTS), atOlderCap);
assert.deepEqual([toOldest.shift, toOldest.slot], [5, 4], "at the oldest prompt the dial lands on it");
assert.equal(repeatingOf(toOldest), undefined, "and stops turning");
assert.equal(turned(toOldest, "older", PROMPTS), toOldest, "nothing is older than the first prompt");
const atNewerCap = { ...dial(-1), shift: 2 };
const back = turned(turned(atNewerCap, "newer", PROMPTS), "newer", PROMPTS);
assert.deepEqual([back.shift, back.slot], [0, 0], "turning back to the newest lands on it");
assert.equal(repeatingOf(back), undefined);
const newest = dial(0);
assert.equal(turned(newest, "newer", PROMPTS), newest, "nothing is newer than the newest prompt");
console.log("prompt dial: repeats only from an open dial's caps, one prompt a turn, and stops at the oldest and the newest");
