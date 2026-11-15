import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { Type } from "typebox";
import { checkJson, valueOrThrow } from "../src/parse.ts";
import { Action, Key, Observation, Reason, Role, State, type Capabilities, type Node, type Outcome, type ScreenDriver, type Step, type Surface, type Target } from "../src/screen/driver.ts";
import { diff, encode } from "../src/screen/encode.ts";
import { exitOnFailures, updating } from "./snapshot.ts";

const FIXTURES = new URL("./fixtures/screen/", import.meta.url);
const OBSERVATION_CHARS: Record<string, { before: number; after: number }> = {
	"settings-apps.json": { before: 324, after: 269 },
	"chat-list.json": { before: 629, after: 169 },
	"checkout.json": { before: 655, after: 250 },
};
const DIFF_CHARS: Record<string, number> = { "settings-apps.json": 67, "chat-list.json": 201, "checkout.json": 171 };
const Fixture = Type.Object({ before: Observation, after: Observation });
const scope = { conversation: "fixture", surface: "front" } as const;
const failures: string[] = [];

function budget(name: string, actual: number, allowed: number | undefined, ratchet: string): void {
	if (allowed === undefined || actual > allowed) failures.push(`${name} encodes to ${actual} characters, ${allowed ?? "no baseline"} allowed (${ratchet}): prune in src/screen/encode.ts, or raise it with a measured row in docs/tools.md`);
	if (allowed !== undefined && actual < allowed) failures.push(`${name} encodes to ${actual} characters, fewer than ${ratchet} (${allowed}): lower it to ${actual} so the ratchet holds`);
}

for (const name of readdirSync(FIXTURES).filter((file) => file.endsWith(".json"))) {
	const checked = checkJson(Fixture, readFileSync(new URL(name, FIXTURES), "utf8"), name);
	assert(checked.ok, `fixture ${name} no longer matches Observation: re-record it with test/device/screen-record.sh${checked.ok ? "" : ` (${checked.problem})`}`);
	const { before, after } = checked.value;
	for (const observation of [before, after]) {
		assert.equal(new Set(observation.nodes.map((node) => node.ref)).size, observation.nodes.length, `${name}: refs must be unique`);
		assert(observation.nodes.every((node) => observation.windows[node.window]), `${name}: nodes must belong to a window`);
	}
	const first = encode(before, scope);
	const second = encode(after, scope, first.ids);
	const delta = diff(before, after, scope);
	for (const [part, text] of [["before", first.text], ["after", second.text], ["diff", delta.text]] as const) {
		const golden = new URL(`${name.slice(0, -5)}.${part}.txt`, FIXTURES);
		if (updating) writeFileSync(golden, `${text}\n`);
		assert.equal(`${text}\n`, readFileSync(golden, "utf8"), `${name} ${part}: review the changed lines before updating the golden`);
	}
	budget(`${name} before`, first.text.length, OBSERVATION_CHARS[name]?.before, "OBSERVATION_CHARS");
	budget(`${name} after`, second.text.length, OBSERVATION_CHARS[name]?.after, "OBSERVATION_CHARS");
	budget(name, delta.text.length, DIFF_CHARS[name], "DIFF_CHARS");
	assert.equal(diff(before, before, scope).text, "");
	assert.deepEqual(delta.ids, second.ids);
	console.log(`${name}: observation ${first.text.length}/${second.text.length}, diff ${delta.text.length}`);
}
for (const name of new Set([...Object.keys(OBSERVATION_CHARS), ...Object.keys(DIFF_CHARS)])) {
	assert(readdirSync(FIXTURES).includes(name), `${name} has no fixture: remove its OBSERVATION_CHARS and DIFF_CHARS entries`);
}

const node: Node = { ref: "one", role: "button", name: "  Save\n \"draft\"  ", at: [10, 20], depth: 0, state: [], window: 0 };
const observation: Observation = { size: [100, 200], keyboard: false, windows: [{ kind: "app" }], nodes: [node], truncated: 0 };
const original = JSON.stringify(observation);
const first = encode(observation, scope);
assert(first.text.includes('e1 button "Save \\"draft\\""'));
assert(!first.text.includes("@10,20"));
const next = { ...observation, nodes: [{ ...node, ref: "two", name: "Second" }, node] };
const second = encode(next, scope, first.ids);
assert(second.text.includes('e2 button "Second"'));
assert(second.text.includes("e1 button"));
assert.deepEqual(first.ids.refs, ["one"]);
assert.equal(JSON.stringify(observation), original);
assert.deepEqual(encode(next, scope, first.ids), second);
assert.equal(encode(next, { surface: "front", conversation: "fixture" }, first.ids).text, second.text);
assert.equal(encode({ ...observation, nodes: [{ ...node, name: " \n " }] }, scope).text.includes("e1 button @10,20"), true);
for (const surface of ["background", { window: "other" }] satisfies Surface[]) {
	assert(encode(next, { ...scope, surface }, first.ids).text.includes('e1 button "Second"'));
}
assert(encode(next, { ...scope, conversation: "other" }, first.ids).text.includes('e1 button "Second"'));
const removed = encode({ ...observation, nodes: [] }, scope, second.ids);
assert(encode(observation, scope, removed.ids).text.includes("e1 button"));
assert.equal(diff(observation, { ...observation, nodes: [] }, scope).text, "gone: e1");
assert.equal(diff(observation, { ...observation, nodes: [{ ...node, at: [50, 60] }] }, scope).text, "");
assert(diff(observation, { ...observation, nodes: [{ ...node, state: ["disabled"] }] }, scope).text.includes("disabled"));

const run = Array.from({ length: 28 }, (_, index) => ({ ...node, ref: `n${index}`, name: `Card ${index}`, depth: 1 }));
const nested = encode({ ...observation, truncated: 4, nodes: [{ ...node, ref: "wrapper", role: "group", name: "" }, ...run, { ...node, ref: "child", role: "text", depth: 2, name: "Card details remain" }, { ...node, ref: "end", role: "link", depth: 1, name: "Next page" }, { ...node, ref: "reset", depth: 1 }] }, scope);
assert.equal(nested.truncated, 7);
assert(!nested.text.includes("Card 25"));
assert(nested.text.includes("Card details remain"));
assert(nested.text.includes("Next page"));
assert(nested.text.includes("Save"));
assert(!nested.text.includes("group"));
const long = encode({ ...observation, nodes: [{ ...node, name: "a".repeat(301), value: "b".repeat(301) }] }, scope);
assert.equal(long.truncated, 1);
assert(long.text.includes(`${"a".repeat(299)}…`));
assert(!long.text.includes("a".repeat(300)));
const password = encode({ ...observation, nodes: [{ ...node, role: "field", name: "Password", value: "••••", state: ["password"] }] }, scope);
assert(password.text.includes('="••••" password'));
assert(!encode({ ...observation, shot: { jpeg: "not model text" } }, scope).text.includes("not model text"));
assert(encode({ ...observation, shot: { blocked: "gated" } }, scope).text.includes("shot:gated"));
assert.equal(valueOrThrow(checkJson(Observation, JSON.stringify(observation), "observation")).nodes.length, 1);
assert(!checkJson(Observation, JSON.stringify({ ...observation, nodes: [{ ...node, role: "unknown" }] }), "bad role").ok);
assert(!checkJson(Observation, JSON.stringify({ ...observation, truncated: -1 }), "bad truncation").ok);

const target: Target = { text: "Save", role: "button" };
const steps: Step[] = [
	{ action: "tap", target }, { action: "long_press", target: { ref: "one" } }, { action: "type", text: "draft", target: { x: 10, y: 20 }, submit: true },
	{ action: "clear" }, { action: "key", key: "enter" }, { action: "scroll", direction: "down" }, { action: "scroll_to", text: "End" },
	{ action: "swipe", from: [0, 0], to: [10, 20], ms: 300 }, { action: "open", app: "Settings" }, { action: "wait", ms: 100 },
	{ action: "wait_for", text: "Ready", gone: false, ms: 1000 }, { action: "expect", text: "Ready" }, { action: "hand_over", reason: "Sign in" },
];
const capabilities: Capabilities = { steps: Action, keys: Key, targets: ["ref", "text", "point"], surfaces: ["front", "background", "window"], shot: true, preview: false };
const outcomes: Outcome[] = [{ ok: true }, ...Reason.map((reason) => ({ ok: false, reason }) as const)];
const result: Awaited<ReturnType<ScreenDriver["act"]>> = { ran: outcomes, after: observation };
assert.deepEqual(steps.map((step) => step.action), capabilities.steps);
assert.equal(result.ran.length, Reason.length + 1);
assert(Role.includes(node.role));
assert(State.includes("checked"));
exitOnFailures(failures);
console.log("screen observations: goldens, budgets, scoped ids, pruning, diffs and vocabulary passed");
