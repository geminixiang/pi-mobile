import assert from "node:assert/strict";
import { type Budget, type Dialing, type LinkState, type Rules, step, type World } from "../../src/computer/resumable-link.ts";
import type { Check } from "./setup.ts";

type Socket = { name: string };
const old: Socket = { name: "old" };
const fresh: Socket = { name: "fresh" };
const rules: Rules = { what: "mac", quietLimitMs: 20_000, resumeLimitMs: 270_000 };
const online = (now: number, kept = 0): World => ({ now, online: true, kept });
const offline = (now: number): World => ({ now, online: false, kept: 0 });
const budget = (unreachableMs: number, onlineSince: number | undefined): Budget => ({ unreachableMs, onlineSince });

const up: LinkState<Socket> = { kind: "up", socket: old, heardAt: 1000 };
const dialing: Dialing<Socket> = { kind: "dialing", attempt: 2, budget: budget(0, 5000) };
const resuming: LinkState<Socket> = { kind: "resuming", attempt: 2, budget: budget(0, 5000), socket: fresh, heardAt: 6000 };
const waiting: LinkState<Socket> = { kind: "waiting", attempt: 1, budget: budget(0, 5000), delay: 2000 };
const away: LinkState<Socket> = { kind: "offline", attempt: 1, budget: budget(3000, undefined) };
const closed: LinkState<Socket> = { kind: "closed" };

const unchanged = (state: LinkState<Socket>, result: ReturnType<typeof step<Socket>>) => {
	assert.equal(result.state, state);
	assert.deepEqual(result.effects, []);
};

export const checks: Check[] = [
	[
		"link: the first socket that opens is up, and one that opens late is closed",
		async () => {
			assert.deepEqual(step({ kind: "opening", heardAt: 10 }, { kind: "opened", socket: old }, online(50), rules), { state: { kind: "up", socket: old, heardAt: 10 }, effects: [] });
			assert.deepEqual(step(closed, { kind: "opened", socket: old }, online(50), rules), { state: closed, effects: [{ kind: "close", socket: old, code: 1000 }] });
		},
	],
	[
		"link: a message on the live socket is delivered, and one on any other socket or state is dropped",
		async () => {
			assert.deepEqual(step(up, { kind: "message", socket: old, data: "a" }, online(9000), rules), { state: { kind: "up", socket: old, heardAt: 9000 }, effects: [{ kind: "deliver", data: "a" }] });
			unchanged(up, step(up, { kind: "message", socket: fresh, data: "a" }, online(9000), rules));
			for (const state of [dialing, waiting, away, closed]) unchanged(state, step(state, { kind: "message", socket: old, data: "a" }, online(9000), rules));
		},
	],
	[
		"link: the computer's count brings a resuming socket up and resends from it; anything else, or a count below what the phone kept, is final",
		async () => {
			assert.deepEqual(step(resuming, { kind: "message", socket: fresh, data: '{"received":4}' }, online(7000, 3), rules), {
				state: { kind: "up", socket: fresh, heardAt: 7000 },
				effects: [{ kind: "resend", socket: fresh, from: 4, attempts: 2 }],
			});
			assert.deepEqual(step(resuming, { kind: "message", socket: fresh, data: "hello" }, online(7000), rules), {
				state: closed,
				effects: [
					{ kind: "close", socket: fresh, code: 1000 },
					{ kind: "final", reason: "mac answered the resume with something else" },
				],
			});
			assert.deepEqual(step(resuming, { kind: "message", socket: fresh, data: '{"received":2}' }, online(7000, 3), rules).effects.at(-1), {
				kind: "final",
				reason: "mac is missing more than this phone kept; the command may still be running there",
			});
		},
	],
	[
		"link: a live socket that ends with a reason is final, without one it waits to reattach from attempt 0 with a fresh budget",
		async () => {
			assert.deepEqual(step(up, { kind: "ended", socket: old, reason: "no such session" }, online(9000), rules).effects, [
				{ kind: "close", socket: old, code: 1000 },
				{ kind: "final", reason: "no such session" },
			]);
			assert.deepEqual(step(up, { kind: "ended", socket: old, reason: undefined }, online(9000), rules), {
				state: { kind: "waiting", attempt: 0, budget: budget(0, 9000), delay: 1000 },
				effects: [{ kind: "dropped" }],
			});
			assert.deepEqual(step(up, { kind: "ended", socket: old, reason: undefined }, offline(9000), rules), {
				state: { kind: "offline", attempt: 0, budget: budget(0, undefined) },
				effects: [{ kind: "dropped" }],
			});
			assert.deepEqual(step(resuming, { kind: "ended", socket: fresh, reason: undefined }, online(9000), rules), {
				state: { kind: "waiting", attempt: 2, budget: budget(0, 5000), delay: 4000 },
				effects: [],
			});
			unchanged(up, step(up, { kind: "ended", socket: fresh, reason: undefined }, online(9000), rules));
			for (const state of [dialing, waiting, away, closed]) unchanged(state, step(state, { kind: "ended", socket: old, reason: "x" }, online(9000), rules));
		},
	],
	[
		"link: a socket quiet past the limit is closed without a code and reattached; one heard from in time, or no socket, is left alone",
		async () => {
			assert.deepEqual(step(up, { kind: "quiet" }, online(21_001), rules), {
				state: { kind: "waiting", attempt: 0, budget: budget(0, 21_001), delay: 1000 },
				effects: [{ kind: "close", socket: old, code: undefined }, { kind: "dropped" }],
			});
			unchanged(up, step(up, { kind: "quiet" }, online(21_000), rules));
			for (const state of [dialing, waiting, away, closed]) unchanged(state, step(state, { kind: "quiet" }, online(99_000), rules));
		},
	],
	[
		"link: a retry dials with the next attempt, the network coming back dials from attempt 0, and neither dials while offline",
		async () => {
			const retried = step(waiting, { kind: "retry" }, online(8000), rules);
			assert.deepEqual(retried.state, { kind: "dialing", attempt: 2, budget: budget(0, 5000) });
			assert.deepEqual(retried.effects, [{ kind: "dial", from: retried.state }]);
			assert.deepEqual(step(away, { kind: "network" }, online(8000), rules).state, { kind: "dialing", attempt: 1, budget: budget(3000, 8000) });
			assert.deepEqual(step(waiting, { kind: "network" }, offline(8000), rules), { state: { kind: "offline", attempt: 0, budget: budget(3000, undefined) }, effects: [] });
			for (const state of [up, dialing, resuming, away, closed]) unchanged(state, step(state, { kind: "retry" }, online(8000), rules));
			for (const state of [up, dialing, resuming, closed]) unchanged(state, step(state, { kind: "network" }, online(8000), rules));
		},
	],
	[
		"link: only time online counts toward giving up, and past the limit the phone gives up with a named reason",
		async () => {
			const spent: LinkState<Socket> = { kind: "waiting", attempt: 4, budget: budget(200_000, 0), delay: 15000 };
			assert.equal(step(spent, { kind: "retry" }, online(70_000), rules).state.kind, "dialing");
			assert.deepEqual(step(spent, { kind: "retry" }, online(70_001), rules), {
				state: closed,
				effects: [
					{ kind: "gave_up", attempts: 4 },
					{ kind: "final", reason: "could not reach mac for 4.5 minutes while this phone was online" },
				],
			});
			assert.deepEqual(step(spent, { kind: "retry" }, offline(999_000), rules).state, { kind: "offline", attempt: 4, budget: budget(1_199_000, undefined) });
		},
	],
	[
		"link: a dial that answers for the current attempt resumes on it; a stale one is closed and a stale failure is ignored",
		async () => {
			assert.deepEqual(step(dialing, { kind: "dialed", from: dialing, socket: fresh }, online(6000), rules), {
				state: { kind: "resuming", attempt: 2, budget: budget(0, 5000), socket: fresh, heardAt: 6000 },
				effects: [],
			});
			const other: Dialing<Socket> = { ...dialing };
			assert.deepEqual(step(dialing, { kind: "dialed", from: other, socket: fresh }, online(6000), rules), { state: dialing, effects: [{ kind: "close", socket: fresh, code: 1000 }] });
			assert.deepEqual(step(dialing, { kind: "unreachable", from: dialing }, online(6000), rules).state, { kind: "waiting", attempt: 2, budget: budget(0, 5000), delay: 4000 });
			unchanged(dialing, step(dialing, { kind: "unreachable", from: other }, online(6000), rules));
			unchanged(up, step(up, { kind: "unreachable", from: dialing }, online(6000), rules));
		},
	],
	[
		"link: closing ends every state once, and tells the computer on purpose when a socket is open",
		async () => {
			assert.deepEqual(step(up, { kind: "close" }, online(0), rules), { state: closed, effects: [{ kind: "close", socket: old, code: 1000 }] });
			assert.deepEqual(step(resuming, { kind: "close" }, online(0), rules), { state: closed, effects: [{ kind: "close", socket: fresh, code: 1000 }] });
			for (const state of [dialing, waiting, away]) assert.deepEqual(step(state, { kind: "close" }, online(0), rules), { state: closed, effects: [] });
			unchanged(closed, step(closed, { kind: "close" }, online(0), rules));
		},
	],
];
