import assert from "node:assert/strict";
import { Buffer } from "buffer";
import { type Daemon, type DaemonStream, daemonStep, read, type Reader } from "../../src/agent/sandbox/daemon-state.ts";
import type { Check } from "./setup.ts";

const stream: DaemonStream = { send: () => undefined, close: () => undefined };
const other: DaemonStream = { send: () => undefined, close: () => undefined };
const bytes = (...values: number[]) => new Uint8Array(values);
const opening: Daemon = { kind: "opening", queued: [bytes(1)] };
const open: Daemon = { kind: "open", stream, line: { kind: "up" } };
const down: Daemon = { kind: "open", stream, line: { kind: "down", link: "reattaching", since: 5 } };
const ended: Daemon = { kind: "ended" };
const marker = Buffer.from("PI-ENV t\n", "utf8");
const frameOf = (...payload: number[]) => Buffer.concat([Buffer.from([0, 0, 0, payload.length]), Buffer.from(payload)]);

export const checks: Check[] = [
	[
		"daemon: what was written before the stream opened is sent first; a stream that opens after the end is closed",
		async () => {
			assert.deepEqual(daemonStep(opening, { kind: "opened", stream }), { state: open, effects: [{ kind: "send", stream, data: [bytes(1)] }] });
			assert.deepEqual(daemonStep(ended, { kind: "opened", stream }), { state: ended, effects: [{ kind: "close", stream }] });
			assert.deepEqual(daemonStep(open, { kind: "opened", stream: other }), { state: open, effects: [{ kind: "close", stream: other }] });
		},
	],
	[
		"daemon: writes queue while opening, go straight out when open, and vanish after the end",
		async () => {
			assert.deepEqual(daemonStep(opening, { kind: "write", data: bytes(2) }), { state: { kind: "opening", queued: [bytes(1), bytes(2)] }, effects: [] });
			assert.deepEqual(daemonStep(down, { kind: "write", data: bytes(2) }), { state: down, effects: [{ kind: "send", stream, data: [bytes(2)] }] });
			assert.deepEqual(daemonStep(ended, { kind: "write", data: bytes(2) }), { state: ended, effects: [] });
		},
	],
	[
		"daemon: a stream that never opens fails with its reason once, and a failure after it opened is ignored",
		async () => {
			assert.deepEqual(daemonStep(opening, { kind: "failed", reason: "連不到 mac" }), {
				state: ended,
				effects: [
					{ kind: "error", reason: "連不到 mac" },
					{ kind: "lost", reason: "連不到 mac" },
				],
			});
			for (const state of [open, ended]) assert.deepEqual(daemonStep(state, { kind: "failed", reason: "x" }), { state, effects: [] });
		},
	],
	[
		"daemon: the end closes an open stream and reports the loss once",
		async () => {
			assert.deepEqual(daemonStep(down, { kind: "end", reason: "gone" }), {
				state: ended,
				effects: [
					{ kind: "close", stream },
					{ kind: "lost", reason: "gone" },
				],
			});
			assert.deepEqual(daemonStep(opening, { kind: "end", reason: "gone" }), { state: ended, effects: [{ kind: "lost", reason: "gone" }] });
			assert.deepEqual(daemonStep(ended, { kind: "end", reason: "again" }), { state: ended, effects: [] });
		},
	],
	[
		"daemon: the link going down and up is reported only while open",
		async () => {
			assert.deepEqual(daemonStep(open, { kind: "link", link: "offline", now: 9 }), { state: { kind: "open", stream, line: { kind: "down", link: "offline", since: 9 } }, effects: [{ kind: "status" }] });
			assert.deepEqual(daemonStep(down, { kind: "link", link: "up", now: 9 }), { state: open, effects: [{ kind: "status" }] });
			for (const state of [opening, ended]) assert.deepEqual(daemonStep(state, { kind: "link", link: "offline", now: 9 }), { state, effects: [] });
		},
	],
	[
		"daemon: bytes before the greeting wait for it, then whole frames go out and a partial one waits for the rest",
		async () => {
			const start: Reader = { kind: "greeting", pending: Buffer.alloc(0) };
			const noise = read(start, Buffer.from("login banner\nPI-EN"), marker);
			assert.equal(noise.greeted, false);
			assert.equal(noise.frames, undefined);
			const greeted = read(noise.reader, Buffer.concat([Buffer.from("V t\n"), frameOf(7), frameOf(8, 9).subarray(0, 3)]), marker);
			assert.equal(greeted.greeted, true);
			assert.deepEqual(greeted.frames, Buffer.concat([Buffer.from("login banner\nPI-ENV t\n"), frameOf(7)]));
			assert.deepEqual(greeted.reader, { kind: "framed", pending: [new Uint8Array(frameOf(8, 9).subarray(0, 3))], bytes: 3, need: 4 });
			const short = read(greeted.reader, frameOf(8, 9).subarray(3, 5), marker);
			assert.equal(short.frames, undefined);
			assert.equal(short.reader.kind === "framed" && short.reader.need, 6);
			const rest = read(short.reader, frameOf(8, 9).subarray(5), marker);
			assert.deepEqual(rest.frames, frameOf(8, 9));
			assert.deepEqual(rest.reader, { kind: "framed", pending: [], bytes: 0, need: 4 });
		},
	],
];
