import assert from "node:assert/strict";
import { fauxAssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { MEMORY_LIMIT } from "../src/agent/memory.ts";
import type { AgentRuntime, ConversationId } from "../src/agent/runtime.ts";
import type { Host } from "../src/agent/sandbox/host.ts";
import { budgetOf, fit, PROMPT_BUDGET } from "../src/agent/section.ts";
import { keepOpen, openRuntime, turn } from "./contracts/fixtures.ts";
import { logged } from "./contracts/setup.ts";
import { snapshotFailures, updating } from "./snapshot.ts";

const SNAPSHOT = new URL("./prompt.snapshot.json", import.meta.url);
const ZONE = /\([^()]*, UTC[^()]*\)/;

async function sections(runtime: AgentRuntime, bot: ConversationId): Promise<[string, string][]> {
	let seen: [string, string][] = [];
	await turn(runtime, bot, [
		(context: TranscriptContext) => {
			const first = context.messages[0];
			const rendered: unknown = first && "sections" in first ? first.sections : undefined;
			seen = typeof rendered === "object" && rendered !== null ? Object.entries(rendered).flatMap(([key, text]): [string, string][] => (typeof text === "string" ? [[key, text]] : [])) : [];
			return fauxAssistantMessage("done");
		},
	]);
	return seen;
}

const failures: string[] = [];

const fresh = await openRuntime();
try {
	const bot = await fresh.runtime.createBot({ name: "tmp", job: "", avatar: "helper" });
	const current = (await sections(fresh.runtime, bot)).map(([name, rendered]) => ({ name, text: rendered.replace(ZONE, "(ZONE)") })).map(({ name, text }) => ({ name, chars: text.length, text }));
	failures.push(...snapshotFailures(SNAPSHOT, current, "prompt section", "its text"));
} finally {
	await fresh.runtime.close();
}

const offline: Host = { id: "127.0.0.1", address: "127.0.0.1", name: "Offline", os: "linux", arch: "arm64", user: "fixture", home: "/home/fixture", engine: "docker" };
const crowded = await openRuntime(keepOpen(new MemoryStorage()), { hosts: [offline], computer: "" });
try {
	const keep = await crowded.runtime.createBot({ name: "keep", job: "", avatar: "helper" });
	for (let i = 0; i < 40; i++) await crowded.runtime.removeBot(await crowded.runtime.createBot({ name: `gone-${i}`, job: "a job nobody does any more\nwith a second line", avatar: "helper" }));
	for (let i = 0; i < 20; i++) await crowded.runtime.createBot({ name: `live-${i}`, job: "a long job description that the other bots never need to read in full", avatar: "helper" });
	const full = Array.from({ length: MEMORY_LIMIT }, (_, i) => (i % 40 === 39 ? "\n" : "x")).join("");
	await crowded.runtime.saveMemory({ kind: "global" }, full);
	await crowded.runtime.saveMemory({ kind: "bot", id: keep }, full);
	for (const toolset of await crowded.runtime.toolsets(keep)) await crowded.runtime.setToolset(keep, toolset.id, true);
	const before = logged.length;
	const seen = await sections(crowded.runtime, keep);
	const total = seen.reduce((sum, [, text]) => sum + text.length, 0);
	for (const [key, text] of seen) {
		const budget = budgetOf(key);
		if (budget === undefined) failures.push(`section ${key} has no budget: define it with appSection (src/agent/section.ts)`);
		else if (text.length > budget) failures.push(`section ${key} is ${text.length} characters, over its budget of ${budget}`);
	}
	if (total > PROMPT_BUDGET) failures.push(`the prompt is ${total} characters with a crowded app, over PROMPT_BUDGET ${PROMPT_BUDGET}`);
	if (seen.some(([, text]) => text.includes("gone-"))) failures.push("a removed bot is still named in the prompt");
	if (seen.some(([, text]) => text.includes("a long job description"))) failures.push("another bot's job is in the prompt; name the other bots only");
	const cut = logged.slice(before).filter((entry) => entry.event === "prompt.section_over_budget");
	if (cut.length > 0) failures.push(`sections cut to their budget with ordinary data: ${cut.map((entry) => String(entry.fields.section)).join(", ")}; raise the budget or make the section shorter`);
	assert.equal(fit("a\nb\nc", 10), "a\nb\nc");
	assert.ok(fit(`${"line\n".repeat(50)}`, 100).length <= 100);
	assert.ok(fit(`${"line\n".repeat(50)}`, 100).endsWith("(cut to fit the prompt)"));
} finally {
	await crowded.runtime.close();
}

if (failures.length > 0) {
	process.stderr.write(`${failures.map((failure) => `✖ ${failure}`).join("\n")}\n`);
	process.exit(1);
}
process.stdout.write(`prompt: every section has a budget and stays in it with a crowded app${updating ? " (snapshot updated)" : ", and matches the snapshot"}\n`);
