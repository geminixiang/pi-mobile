import wire from "../host/protocol.json" with { type: "json" };
import { RESUME_LIMIT_MS } from "../src/computer/resumable-socket.ts";

type Up = { kind: "data"; seq: number };
type Down = { kind: "resume"; received: number } | { kind: "out"; seq: number } | { kind: "close"; reason: string };
type Conn = { up: Up[]; down: Down[]; broken: boolean };

type Phone = { kind: "up"; conn: number } | { kind: "resuming"; conn: number; unreachable: number } | { kind: "waiting"; unreachable: number } | { kind: "closed"; reason: string };
type Computer =
	| { kind: "attached"; conn: number }
	| { kind: "away"; minutes: number; phoneOffline: boolean }
	| { kind: "exited"; minutes: number; phoneOffline: boolean }
	| { kind: "finished"; reason: string };

type World = {
	phone: Phone;
	written: number;
	kept: number;
	received: number;
	computer: Computer;
	output: number;
	held: number;
	counted: number;
	stdin: number;
	pending: { conn: number; seq: number }[];
	conns: Conn[];
	drops: number;
	dials: number;
	online: boolean;
	outages: number;
};

export type Model = {
	inputs: number;
	outputs: number;
	phoneKeeps: number;
	computerKeeps: number;
	drops: number;
	dials: number;
	outages: number;
	holdMinutes: number;
	limitMinutes: number;
	inputInCountOrder: boolean;
};

type Next = { label: string; world: World };
type Explored = { states: number; endings: Map<string, number>; violation: { problem: string; trace: string[] } | undefined };

const GONE = "no such session";
const BEHIND = "too far behind to resume";
const EXITED = "exit";
const MISSING = "missing more than this phone kept";
const GAVE_UP = "gave up";

const START: World = {
	phone: { kind: "up", conn: 0 },
	written: 0,
	kept: 0,
	received: 0,
	computer: { kind: "attached", conn: 0 },
	output: 0,
	held: 0,
	counted: 0,
	stdin: 0,
	pending: [],
	conns: [{ up: [], down: [], broken: false }],
	drops: 0,
	dials: 0,
	online: true,
	outages: 0,
};

function phoneConn(phone: Phone): number | undefined {
	return phone.kind === "up" || phone.kind === "resuming" ? phone.conn : undefined;
}

function computerConn(computer: Computer): number | undefined {
	return computer.kind === "attached" ? computer.conn : undefined;
}

function withConn(world: World, index: number, change: (conn: Conn) => Conn): World {
	return { ...world, conns: world.conns.map((conn, at) => (at === index ? change(conn) : conn)) };
}

function sendDown(world: World, index: number, messages: Down[]): World {
	return withConn(world, index, (conn) => (conn.broken ? conn : { ...conn, down: [...conn.down, ...messages] }));
}

function sendUp(world: World, index: number, messages: Up[]): World {
	return withConn(world, index, (conn) => (conn.broken ? conn : { ...conn, up: [...conn.up, ...messages] }));
}

function range(from: number, to: number): number[] {
	return Array.from({ length: Math.max(0, to - from) }, (_, offset) => from + offset);
}

function canonical(world: World): World {
	const live = [phoneConn(world.phone), computerConn(world.computer), ...world.pending.map((entry) => entry.conn)].filter((conn) => conn !== undefined);
	const order = [...new Set(live)];
	const renumber = (conn: number) => order.indexOf(conn);
	const phone: Phone = world.phone.kind === "up" || world.phone.kind === "resuming" ? { ...world.phone, conn: renumber(world.phone.conn) } : world.phone;
	const computer: Computer = world.computer.kind === "attached" ? { kind: "attached", conn: renumber(world.computer.conn) } : world.computer;
	return {
		...world,
		phone,
		computer,
		pending: world.pending.map((entry) => ({ ...entry, conn: renumber(entry.conn) })),
		conns: order.map((conn) => world.conns[conn] ?? { up: [], down: [], broken: true }),
	};
}

function write(world: World, seq: number): World | string {
	if (seq !== world.stdin) return `stdin got input ${seq} when input ${world.stdin} was next`;
	return { ...world, stdin: world.stdin + 1 };
}

function kill(world: World, reason: string): World {
	return { ...world, computer: { kind: "finished", reason } };
}

function attach(world: World): World {
	const conn = world.conns.length;
	const opened: World = { ...world, conns: [...world.conns, { up: [], down: [], broken: false }], dials: world.dials + 1 };
	const unreachable = world.phone.kind === "waiting" ? world.phone.unreachable : 0;
	const dialed: World = { ...opened, phone: { kind: "resuming", conn, unreachable } };
	const have = world.received;
	if (world.computer.kind === "finished") return sendDown(dialed, conn, [{ kind: "close", reason: GONE }]);
	if (have < world.held || have > world.output) return sendDown(dialed, conn, [{ kind: "close", reason: BEHIND }]);
	const replaced = world.computer.kind === "attached" ? sendDown(dialed, world.computer.conn, [{ kind: "close", reason: "replaced by a newer connection" }]) : dialed;
	const resent: Down[] = [{ kind: "resume", received: world.counted }, ...range(have, world.output).map((seq): Down => ({ kind: "out", seq }))];
	if (world.computer.kind === "exited") return kill(sendDown(replaced, conn, [...resent, { kind: "close", reason: EXITED }]), EXITED);
	return sendDown({ ...replaced, computer: { kind: "attached", conn } }, conn, resent);
}

function produce(world: World, model: Model): World {
	const seq = world.output;
	const sent = world.computer.kind === "attached" ? sendDown(world, world.computer.conn, [{ kind: "out", seq }]) : world;
	const grown = { ...sent, output: seq + 1 };
	if (grown.output - grown.held <= model.computerKeeps) return grown;
	if (grown.computer.kind === "attached") return { ...grown, held: grown.held + 1 };
	return kill(grown, GONE);
}

function hear(world: World, conn: number, message: Down): World | string {
	const phone = world.phone;
	if (phone.kind === "resuming") {
		if (message.kind === "close") return { ...world, phone: { kind: "closed", reason: message.reason } };
		if (message.kind !== "resume") return "the computer answered an attach with output before its count";
		if (message.received < world.kept) return { ...world, phone: { kind: "closed", reason: MISSING } };
		const resent = range(message.received, world.written).map((seq): Up => ({ kind: "data", seq }));
		return sendUp({ ...world, phone: { kind: "up", conn } }, conn, resent);
	}
	if (message.kind === "close") return { ...world, phone: { kind: "closed", reason: message.reason } };
	if (message.kind === "resume") return "a count arrived on a link that was already up";
	if (message.seq !== world.received) return `the phone got output ${message.seq} when output ${world.received} was next`;
	return { ...world, received: world.received + 1 };
}

function tick(world: World, model: Model): World | string {
	const phone: Phone =
		world.phone.kind === "waiting" || world.phone.kind === "resuming"
			? world.online && world.phone.unreachable + 1 > model.limitMinutes
				? { kind: "closed", reason: GAVE_UP }
				: { ...world.phone, unreachable: world.phone.unreachable + (world.online ? 1 : 0) }
			: world.phone;
	const computer = world.computer;
	if (computer.kind !== "away" && computer.kind !== "exited") return { ...world, phone };
	const waited = { ...computer, minutes: computer.minutes + 1, phoneOffline: computer.phoneOffline || !world.online };
	if (waited.minutes <= model.holdMinutes) return { ...world, phone, computer: waited };
	if (phone.kind !== "closed" && !waited.phoneOffline) return "the computer let the session go while the phone, online all along, was still reattaching";
	return { ...world, phone, computer: { kind: "finished", reason: GONE } };
}

function linkName(world: World, index: number): string {
	if (phoneConn(world.phone) === index) return "the phone's link";
	if (computerConn(world.computer) === index) return "the computer's link";
	return "an old link";
}

function moves(world: World, model: Model): (Next | { label: string; problem: string })[] {
	const out: (Next | { label: string; problem: string })[] = [];
	const add = (label: string, next: World | string) => out.push(typeof next === "string" ? { label, problem: next } : { label, world: next });
	const { phone, computer } = world;
	const mine = phoneConn(phone);
	const theirs = computerConn(computer);
	if (phone.kind !== "closed" && world.written < model.inputs) {
		const seq = world.written;
		const logged = { ...world, written: seq + 1, kept: Math.max(world.kept, seq + 1 - model.phoneKeeps) };
		add(`phone writes input ${seq}`, phone.kind === "up" ? sendUp(logged, phone.conn, [{ kind: "data", seq }]) : logged);
	}
	if ((computer.kind === "attached" || computer.kind === "away") && world.output < model.outputs) add(`command writes output ${world.output}`, produce(world, model));
	if ((computer.kind === "attached" || computer.kind === "away") && world.output === model.outputs && world.stdin === model.inputs) {
		const last = produce(world, model);
		const ended: World =
			last.computer.kind === "attached" ? kill(sendDown(last, last.computer.conn, [{ kind: "close", reason: EXITED }]), EXITED) : last.computer.kind === "away" ? { ...last, computer: { ...last.computer, kind: "exited" } } : last;
		add("command exits", ended);
	}
	world.conns.forEach((conn, index) => {
		const [first, ...rest] = conn.up;
		if (first) {
			const read = withConn(world, index, (value) => ({ ...value, up: rest }));
			if (theirs !== index) add(`computer drops a stale input on ${linkName(world, index)}`, read);
			else if (model.inputInCountOrder) add(`computer takes input ${first.seq} on ${linkName(world, index)}`, write({ ...read, counted: read.counted + 1 }, first.seq));
			else add(`computer counts input ${first.seq} on ${linkName(world, index)}`, { ...read, counted: read.counted + 1, pending: [...read.pending, { conn: index, seq: first.seq }] });
		}
		const [heard, ...later] = conn.down;
		if (heard && mine === index) add(`phone hears ${JSON.stringify(heard)} on ${linkName(world, index)}`, hear(withConn(world, index, (value) => ({ ...value, down: later })), index, heard));
		if (conn.broken && conn.up.length > 0) add(`input in flight on ${linkName(world, index)} is lost`, withConn(world, index, (value) => ({ ...value, up: [] })));
		if (conn.broken && conn.down.length > 0) add(`output in flight on ${linkName(world, index)} is lost`, withConn(world, index, (value) => ({ ...value, down: [] })));
		if (!conn.broken && world.drops < model.drops && (mine === index || theirs === index)) add(`${linkName(world, index)} drops`, withConn({ ...world, drops: world.drops + 1 }, index, (value) => ({ ...value, broken: true })));
	});
	const writers = new Set(world.pending.map((entry) => entry.conn));
	for (const conn of writers) {
		const at = world.pending.findIndex((entry) => entry.conn === conn);
		const entry = world.pending[at];
		if (entry) add(`computer writes input ${entry.seq} from ${linkName(world, conn)}`, write({ ...world, pending: world.pending.filter((_, index) => index !== at) }, entry.seq));
	}
	if (mine !== undefined && world.conns[mine]?.broken) {
		const unreachable = phone.kind === "resuming" ? phone.unreachable : 0;
		add("phone notices its link is gone", { ...world, phone: { kind: "waiting", unreachable } });
	}
	if (theirs !== undefined && world.conns[theirs]?.broken) add("computer notices its link is gone", { ...world, computer: { kind: "away", minutes: 0, phoneOffline: false } });
	if (phone.kind === "waiting" && world.online && world.dials < model.dials) add("phone reattaches", attach(world));
	if (world.online && world.outages < model.outages) add("network goes away", { ...world, online: false, outages: world.outages + 1 });
	if (!world.online) add("network comes back", { ...world, online: true });
	const settled = !(mine !== undefined && world.conns[mine]?.broken) && !(theirs !== undefined && world.conns[theirs]?.broken);
	const timed = phone.kind === "waiting" || computer.kind === "away" || computer.kind === "exited";
	if (settled && timed) add("a minute passes", tick(world, model));
	return out;
}

function finalProblem(world: World, model: Model): string | undefined {
	if (world.phone.kind !== "closed") return `nothing more can happen but the phone is still ${world.phone.kind}`;
	if (world.phone.reason !== EXITED) return undefined;
	if (world.stdin !== model.inputs) return `the command exited after ${world.stdin} of ${model.inputs} inputs`;
	if (world.received !== model.outputs + 1) return `the phone saw the exit after ${world.received} of ${model.outputs + 1} outputs`;
	return undefined;
}

export function explore(model: Model): Explored {
	const start = canonical(START);
	const seen = new Map<string, { from: string | undefined; label: string }>([[JSON.stringify(start), { from: undefined, label: "start" }]]);
	const queue: World[] = [start];
	const trace = (key: string | undefined): string[] => {
		const steps: string[] = [];
		for (let at = key; at !== undefined; at = seen.get(at)?.from) steps.unshift(seen.get(at)?.label ?? "?");
		return steps;
	};
	const endings = new Map<string, number>();
	for (let index = 0; index < queue.length; index++) {
		const world = queue[index];
		if (!world) break;
		const key = JSON.stringify(world);
		const next = moves(world, model);
		if (next.length === 0) {
			const problem = finalProblem(world, model);
			if (problem) return { states: seen.size, endings, violation: { problem, trace: trace(key) } };
			const ending = world.phone.kind === "closed" ? world.phone.reason : world.phone.kind;
			endings.set(ending, (endings.get(ending) ?? 0) + 1);
		}
		for (const move of next) {
			if ("problem" in move) return { states: seen.size, endings, violation: { problem: move.problem, trace: [...trace(key), move.label] } };
			const reached = canonical(move.world);
			const reachedKey = JSON.stringify(reached);
			if (seen.has(reachedKey)) continue;
			seen.set(reachedKey, { from: key, label: move.label });
			queue.push(reached);
		}
	}
	return { states: seen.size, endings, violation: undefined };
}

export const PROTOCOL: Model = {
	inputs: 3,
	outputs: 3,
	phoneKeeps: 2,
	computerKeeps: 2,
	drops: 3,
	dials: 4,
	outages: 2,
	holdMinutes: wire.holdMinutes,
	limitMinutes: Math.ceil(RESUME_LIMIT_MS / 60_000),
	inputInCountOrder: true,
};

function expect(name: string, explored: Explored, violated: boolean): string | undefined {
	if (!violated && explored.violation) return `${name}: ${explored.violation.problem}\n  ${explored.violation.trace.join("\n  ")}`;
	if (violated && !explored.violation) return `${name}: the model found no violation in ${explored.states} states, so it cannot tell this bug apart`;
	return undefined;
}

const started = Date.now();
const protocol = explore(PROTOCOL);
const problems = [
	expect("the resume protocol", protocol, false),
	expect("input written in any order across links (host/held.go before the input lock)", explore({ ...PROTOCOL, inputInCountOrder: false }), true),
	expect("a phone that tries longer than the computer holds", explore({ ...PROTOCOL, limitMinutes: PROTOCOL.holdMinutes + 1 }), true),
	...[EXITED, GONE, BEHIND, MISSING, GAVE_UP].filter((reason) => !protocol.endings.has(reason)).map((reason) => `the resume protocol: no run ends with "${reason}", so the model never checks that path`),
].filter((problem) => problem !== undefined);
if (problems.length > 0) {
	console.error(`resume model:\n${problems.join("\n")}`);
	process.exit(1);
}
const endings = [...protocol.endings].map(([reason, count]) => `${count} ${reason}`).join(", ");
console.log(`resume model: ${protocol.states} states, endings ${endings}; every input and output exactly once and in order or a named failure (${Date.now() - started} ms)`);
