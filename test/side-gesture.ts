import assert from "node:assert/strict";
import { intentOf, positionAfter, settleCurve, settlesOpen, towardOpen, velocityOf } from "../src/app/sideGesture.ts";

const move = (dx: number, dy: number, elapsedMs = 50, selecting = false) => intentOf({ dx, dy, elapsedMs, selecting });
assert.equal(move(6, 6), "undecided");
assert.equal(move(30, 4), "swipe");
assert.equal(move(-30, 4), "swipe");
assert.equal(move(30, 20), "ignore");
assert.equal(move(4, 30), "ignore");
assert.equal(move(30, 4, 500), "ignore");
assert.equal(move(30, 4, 50, true), "ignore");

assert.equal(towardOpen("left", 20), 20);
assert.equal(towardOpen("right", 20), -20);

for (const side of ["left", "right"] as const) {
	const open = side === "left" ? 1 : -1;
	assert.equal(positionAfter(side, 0, open * 150, 300), 0.5);
	assert.equal(positionAfter(side, 1, open * 400, 300), 1);
	assert.equal(positionAfter(side, 0, -open * 400, 300), 0);
	assert.equal(positionAfter(side, 1, -open * 600, 300), 0);
	assert.equal(positionAfter(side, 0.4, open * 30, 300), 0.5);
}

assert.equal(velocityOf([], 0), 0);
assert.equal(velocityOf([{ x: 10, t: 0 }], 0), 0);
assert.equal(velocityOf([{ x: 0, t: 0 }, { x: 50, t: 100 }], 100), 0.5);
assert.equal(velocityOf([{ x: 0, t: 0 }, { x: 100, t: 400 }, { x: 140, t: 480 }], 490), 0.5);
assert.equal(velocityOf([{ x: 0, t: 0 }, { x: 50, t: 100 }], 400), 0);

assert.equal(settlesOpen(0.2, 0.4), true);
assert.equal(settlesOpen(0.8, -0.4), false);
assert.equal(settlesOpen(0.6, 0), true);
assert.equal(settlesOpen(0.4, 0.3), false);
assert.equal(settleCurve(0), 0);
assert.equal(settleCurve(1), 1);
assert.equal(settleCurve(2), 1);
assert(settleCurve(0.5) > 0.9 && settleCurve(0.5) < 1);
console.log("side gesture: intent, side, bounds, velocity, settling, and the settle curve hold");
