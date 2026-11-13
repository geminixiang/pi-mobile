import assert from "node:assert/strict";
import { createTraffic, STILL } from "../../src/agent/traffic.ts";
import { nextChange } from "./fixtures.ts";
import { sleep } from "../../src/promise.ts";
import type { Check } from "./setup.ts";

const WINDOW_MS = 200;

export const checks: Check[] = [
	[
		"a link's rate is the bytes it moved in the last second, shown at once when it starts to move",
		async () => {
			const traffic = createTraffic(WINDOW_MS);
			let changes = 0;
			traffic.onChange(() => changes++);
			traffic.count("down", 100);
			assert.equal(changes, 1, "the first bytes after a still link waited for a timer before showing");
			assert.deepEqual(traffic.rates(), { up: 0, down: 500 });
			traffic.count("up", 20);
			traffic.count("down", 60);
			await nextChange(traffic);
			assert.deepEqual(traffic.rates(), { up: 100, down: 800 });
		},
	],
	[
		"a link stops flowing a second after its last byte, and then nothing runs until it moves again",
		async () => {
			const traffic = createTraffic(WINDOW_MS);
			traffic.count("down", 100);
			await sleep(WINDOW_MS * 2);
			assert.equal(traffic.rates(), STILL, "the link still flows a while after nothing moved");
			let changes = 0;
			traffic.onChange(() => changes++);
			await sleep(WINDOW_MS * 3);
			assert.equal(changes, 0, "a still link kept a timer running");
			traffic.count("up", 10);
			assert.equal(changes, 1);
			assert.deepEqual(traffic.rates(), { up: 50, down: 0 });
		},
	],
];
