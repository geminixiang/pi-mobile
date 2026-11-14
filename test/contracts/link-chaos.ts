import assert from "node:assert/strict";
import type { Link, RawMessage } from "../../src/agent/sandbox/resumable-link.ts";
import { RESUME_LIMIT_MS, type RawSocket, ResumableSocket } from "../../src/agent/sandbox/resumable-socket.ts";
import { type ConnectionStatus, type OpenDaemon, PhoneConnection } from "../../src/agent/sandbox/phone-connection.ts";
import { sleep } from "../../src/promise.ts";
import { createTraffic } from "../../src/agent/traffic.ts";
import type { Check } from "./setup.ts";

type Attached = RawSocket & { ready: boolean; closed: boolean; closeCode: number | undefined; deliver(data: string): void; drop(): void };

function seeded(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
		mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
	};
}

function computer() {
	const listeners = new Set<() => void>();
	const state: { online: boolean; live: Attached | undefined; received: number; opened: number } = { online: true, live: undefined, received: 0, opened: 0 };
	const got: string[] = [];
	const sent: string[] = [];
	const events: string[] = [];
	const network = {
		online: () => state.online,
		onChange: (listener: () => void) => {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
	};
	const open = async (url: URL, _what: string, onMessage: (data: RawMessage) => void, onClose: (reason: string | undefined) => void): Promise<RawSocket> => {
		await sleep(0);
		if (!state.online) throw new Error("unreachable");
		state.opened++;
		const have = url.searchParams.get("received");
		const id = state.opened;
		events.push(`open#${id} have=${have}`);
		const socket: Attached = {
			ready: have === null,
			closed: false,
			closeCode: undefined,
			send: (data) => {
				if (socket.closed || state.live !== socket || typeof data !== "string") return;
				got.push(data);
				state.received++;
			},
			close: (code) => {
				socket.closed = true;
				socket.closeCode = code;
				if (state.live === socket) state.live = undefined;
			},
			deliver: (data) => onMessage(data),
			drop: () => {
				if (socket.closed) return;
				events.push(`drop#${id}`);
				socket.closed = true;
				if (state.live === socket) state.live = undefined;
				onClose(undefined);
			},
		};
		state.live?.drop();
		state.live = socket;
		if (have !== null) {
			setTimeout(() => {
				if (socket.closed || state.live !== socket) return;
				events.push(`resume#${id} received=${state.received} replay=${sent.slice(Number(have)).join(",")}`);
				onMessage(JSON.stringify({ received: state.received }));
				for (const data of sent.slice(Number(have))) onMessage(data);
				socket.ready = true;
			}, 0);
		}
		return socket;
	};
	return {
		network,
		open,
		got,
		sent,
		events,
		state,
		emit(data: string) {
			sent.push(data);
			const live = state.live;
			if (live && live.ready && !live.closed) {
				events.push(`emit ${data} live`);
				live.deliver(data);
			} else events.push(`emit ${data} held`);
		},
		setOnline(online: boolean) {
			state.online = online;
			if (!online) state.live?.drop();
			for (const listener of listeners) listener();
		},
	};
}

async function untilUp(links: Link[], ms: number): Promise<boolean> {
	for (let waited = 0; waited < ms; waited += 20) {
		if (links.at(-1) === "up" || links.length === 0) return true;
		await sleep(20);
	}
	return false;
}

async function chaos(seed: number, steps: number) {
	const random = seeded(seed);
	const machine = computer();
	const links: Link[] = [];
	const phoneGot: string[] = [];
	const phoneSent: string[] = [];
	let closedWith: string | undefined | null = null;
	const socket = await ResumableSocket.connect({
		quietLimitMs: 60_000,
		first: new URL("ws://computer/env?token=t"),
		attach: (have) => new URL(`ws://computer/env?attach=t&received=${have}`),
		open: machine.open,
		what: "computer",
		onMessage: (data) => phoneGot.push(typeof data === "string" ? data : "binary"),
		onClose: (reason) => {
			closedWith = reason;
		},
		onLink: (link) => links.push(link),
		network: machine.network,
		resumeLimitMs: RESUME_LIMIT_MS,
		traffic: createTraffic(),
	});
	const trace: string[] = [];
	for (let step = 0; step < steps; step++) {
		const roll = random();
		if (roll < 0.3) {
			const data = `phone ${step}`;
			phoneSent.push(data);
			socket.send(data);
			trace.push("phone");
		} else if (roll < 0.6) {
			machine.emit(`computer ${step}`);
			trace.push("computer");
		} else if (roll < 0.72) {
			machine.state.live?.drop();
			trace.push("drop");
		} else if (roll < 0.8) {
			machine.setOnline(false);
			trace.push("offline");
		} else if (roll < 0.9) {
			machine.setOnline(true);
			trace.push("online");
		} else {
			await sleep(random() < 0.5 ? 0 : 5);
			trace.push("wait");
		}
		await sleep(0);
	}
	machine.setOnline(true);
	const up = await untilUp(links, 8000);
	await sleep(50);
	const outcome = {
		up,
		closedWith,
		computerGotAll: JSON.stringify(machine.got) === JSON.stringify(phoneSent),
		phoneGotAll: JSON.stringify(phoneGot) === JSON.stringify(machine.sent),
	};
	socket.close();
	const last = machine.state.live;
	return { outcome, trace, links, events: machine.events, missingAtComputer: phoneSent.filter((data) => !machine.got.includes(data)), extraAtComputer: machine.got.length - phoneSent.length, missingAtPhone: machine.sent.filter((data) => !phoneGot.includes(data)), extraAtPhone: phoneGot.length - machine.sent.length, closedCleanly: last === undefined };
}

export const checks: Check[] = [
	[
		"through any mix of sends, drops and network changes, each side gets every message exactly once and in order, and the link ends up again",
		async () => {
			for (let seed = 1; seed <= 25; seed++) {
				const run = await chaos(seed, 30);
				const { up, closedWith, computerGotAll, phoneGotAll } = run.outcome;
				const context = `seed ${seed}: ${run.trace.join(" ")} | links ${run.links.join(" ")} | computer saw ${run.events.join("; ")} | missing at computer ${run.missingAtComputer.join(",")} (extra ${run.extraAtComputer}) | missing at phone ${run.missingAtPhone.join(",")} (extra ${run.extraAtPhone})`;
				assert.equal(closedWith, null, `the link never gives up on its own: ${context}`);
				assert.ok(up, `the link is up again once the network is: ${context}`);
				assert.ok(computerGotAll, `the computer got every phone message once, in order: ${context}`);
				assert.ok(phoneGotAll, `the phone got every computer message once, in order: ${context}`);
				assert.ok(run.closedCleanly, `closing leaves no live socket: ${context}`);
			}
		},
	],
	[
		"through any mix of link changes and data split into pieces, the computer's connection is reported connected only after its greeting, says nothing after it ends, and every answer lands whole",
		async () => {
			for (let seed = 1; seed <= 25; seed++) {
				const run = await daemonChaos(seed);
				const context = `seed ${seed}: ${run.events.join("; ")}`;
				assert.equal(run.connectedBeforeGreeting, false, `connected before the computer greeted: ${context}`);
				assert.deepEqual(run.statusesAfterEnd, ["closed"], `after the connection is lost only its closing is reported: ${context}`);
				assert.equal(run.echoed.length, run.wanted.length, context);
				for (const [index, n] of run.wanted.entries()) assert.ok(run.echoed[index]?.includes(`"echo":${n}`), `answer ${index} is ${run.echoed[index]}, not ${n}: ${context}`);
			}
		},
	],
];

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HELLO = { protocol: 1, version: "0.7.0", os: "linux", arch: "arm64", home: "/home/fixture", tmpdir: "/tmp", separator: "/", cwd: "/home/fixture", driveCwds: {}, pid: 42 };

function frame(id: number, json: Record<string, unknown>): Uint8Array {
	const body = encoder.encode(JSON.stringify(json));
	const out = new Uint8Array(13 + body.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, 9 + body.length);
	view.setUint8(4, 2);
	view.setUint32(5, id);
	view.setUint32(9, body.length);
	out.set(body, 13);
	return out;
}

async function daemonChaos(seed: number) {
	const random = seeded(seed);
	const statuses: ConnectionStatus[] = [];
	const events: string[] = [];
	let handlers: Parameters<OpenDaemon>[1] | undefined;
	let token = "";
	let greeted = false;
	const asked: { id: number; json: Record<string, unknown> }[] = [];
	const pieces = (bytes: Uint8Array) => {
		const cuts = [0, ...Array.from({ length: Math.floor(random() * 3) }, () => Math.floor(random() * bytes.length)).sort((a, b) => a - b), bytes.length];
		for (let index = 1; index < cuts.length; index++) {
			const piece = bytes.subarray(cuts[index - 1], cuts[index]);
			if (piece.length > 0) handlers?.onData(piece);
		}
	};
	const flap = () => {
		const link: Link[] = ["reattaching", "offline", "up"];
		const next = link[Math.floor(random() * link.length)] ?? "up";
		events.push(`link ${next}`);
		handlers?.onLink(next);
	};
	const answerAll = () => {
		while (asked.length > 0) {
			const request = asked.shift();
			if (!request) break;
			events.push(`answer ${request.id}`);
			pieces(frame(request.id, request.json.op === "hello" ? HELLO : { echo: request.json.n }));
		}
	};
	const connection = new PhoneConnection({
		open: async (given, opened) => {
			token = given;
			handlers = opened;
			return {
				send: (data) => {
					const view = new DataView(data.buffer, data.byteOffset);
					const id = view.getUint32(5);
					const length = view.getUint32(9);
					asked.push({ id, json: JSON.parse(decoder.decode(data.subarray(13, 13 + length))) });
				},
				close: () => undefined,
			};
		},
		onLog: () => undefined,
		onStatus: (status) => {
			events.push(`status ${status.kind}`);
			statuses.push(status);
		},
	});
	const connected: number[] = [];
	const greet = () => {
		if (greeted) return;
		greeted = true;
		events.push("greet");
		pieces(encoder.encode(`PI-ENV ${token}\n`));
	};
	const info = connection.info();
	await sleep(0);
	for (let step = 0; step < 4; step++) if (random() < 0.6) flap();
	greet();
	answerAll();
	await info;
	const session = await connection.session();
	const replies: Promise<unknown>[] = [];
	const wanted: number[] = [];
	for (let step = 0; step < 12; step++) {
		const roll = random();
		if (roll < 0.4) {
			const n = step;
			wanted.push(n);
			replies.push(connection.request("echo", { n }, { session }));
		} else if (roll < 0.7) flap();
		else answerAll();
		await sleep(0);
	}
	handlers?.onLink("up");
	answerAll();
	const answers = await Promise.all(replies);
	connection.close();
	for (const [index, status] of statuses.entries()) if (status.kind === "connected") connected.push(index);
	const greetedAt = events.indexOf("greet");
	const connectedBeforeGreeting = events.slice(0, greetedAt).includes("status connected");
	const lostAt = statuses.findIndex((status) => status.kind === "lost");
	return {
		events,
		connectedBeforeGreeting,
		statusesAfterEnd: lostAt === -1 ? [] : statuses.slice(lostAt + 1).map((status) => status.kind),
		echoed: answers.map((answer) => JSON.stringify(answer)),
		wanted,
	};
}
