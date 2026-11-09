import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { createComputerAgentsExtension } from "../../src/computer-agents/tool.ts";
import { InteractionExtension } from "../../src/interaction/tool.ts";
import { check, checkJson, valueOrThrow } from "../../src/parse.ts";
import { SCENARIOS, type Scenario } from "./scenarios.ts";

const [modelsArg = "", runsArg = "1", only = ""] = process.argv.slice(2);
const models = modelsArg.split(",").filter(Boolean);
const provider = process.env.MANAGER_PROVIDER_EXTENSION;
if (models.length === 0 || !provider) throw new Error("usage: MANAGER_PROVIDER_EXTENSION=<pi provider extension> node --import ./test/vite-imports.js test/manager/run.ts <provider/model,...> [runs] [scenario]");

const Sections = Type.Array(Type.Object({ name: Type.String(), text: Type.String() }));
const Event = Type.Object({ type: Type.Optional(Type.String()), message: Type.Optional(Type.Object({ role: Type.Optional(Type.String()), content: Type.Optional(Type.Unknown()) })) });
const Part = Type.Object({ type: Type.String(), text: Type.Optional(Type.String()) });
const Content = Type.Array(Part);
const World = Type.Object({ agents: Type.Unknown(), gone: Type.Array(Type.String()), said: Type.Optional(Type.String()), turn: Type.Number(), outside: Type.Optional(Type.Object({ held: Type.Array(Type.Unknown()) })), calls: Type.Array(Type.Object({ tool: Type.String(), args: Type.Record(Type.String(), Type.Unknown()) })) });

const prompt = valueOrThrow(checkJson(Sections, readFileSync(new URL("../prompt.snapshot.json", import.meta.url), "utf8"), "prompt snapshot"));
const extension = createComputerAgentsExtension(() => undefined, { changed: () => undefined, unattended: () => false, notify: async () => "off" }, async () => []);
const tools = [...(extension.tools ?? []), ...(InteractionExtension.tools ?? [])].map(({ name, description, parameters }) => ({ name, description, parameters }));
const dir = mkdtempSync(join(tmpdir(), "manager-"));
const toolsFile = join(dir, "tools.json");
writeFileSync(toolsFile, JSON.stringify(tools));
const LEAD = "Coding agents on the computer are yours to lead through list_agents, tell_agent, read_agent and answer_agent: hand them work with tell_agent, never do it yourself, and when the phone wakes you with [trigger], check the result and report to the user.";
const system = [prompt.find((section) => section.name === "preamble")?.text ?? "", LEAD].join("\n\n");

const TIMED_OUT = "(沒有在時限內結束)";

function ask(model: string, session: string, world: string, text: string, judgeless: boolean): string {
	const result = spawnSync("pi", ["--mode", "json", "--no-extensions", "--no-mcp", "--no-skills", "--session", session, "--tools", tools.map((tool) => tool.name).join(","), "-e", provider ?? "", "-e", new URL("./world.ts", import.meta.url).pathname, "--model", model, "--system-prompt", system, text], {
		encoding: "utf8",
		timeout: 240_000,
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 64 * 1024 * 1024,
		env: { ...process.env, MANAGER_WORLD: world, MANAGER_TOOLS: toolsFile, ...(judgeless ? { MANAGER_JUDGE: "none" } : {}) },
	});
	const replies = result.stdout
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.flatMap((line): string[] => {
			const read = checkJson(Event, line, "pi event");
			if (!read.ok || read.value.type !== "message_end" || read.value.message?.role !== "assistant") return [];
			const content = check(Content, read.value.message.content, "pi content");
			return content.ok ? content.value.filter((part) => part.type === "text").map((part) => part.text ?? "") : [];
		});
	if (result.status !== 0 && replies.length === 0) return TIMED_OUT;
	return replies.join("\n");
}

function run(scenario: Scenario, model: string, index: number) {
	const world = join(dir, `${scenario.name}-${index}.json`);
	const session = join(dir, `${scenario.name}-${index}-${model.replaceAll("/", "_")}.jsonl`);
	writeFileSync(world, JSON.stringify({ agents: scenario.agents, gone: [], turn: 0, calls: [] }));
	let reply = "";
	for (const step of scenario.steps) {
		const state = valueOrThrow(checkJson(World, readFileSync(world, "utf8"), "world"));
		writeFileSync(world, JSON.stringify({ ...state, agents: step.agents ?? state.agents, gone: step.gone ?? state.gone, said: step.say ?? "", turn: state.turn + (step.say === undefined ? 0 : 1) }));
		reply = ask(model, session, world, step.say ?? step.wake ?? "", scenario.judgeless === true);
		if (reply === TIMED_OUT) break;
	}
	const { calls, outside } = valueOrThrow(checkJson(World, readFileSync(world, "utf8"), "world"));
	const problems = reply === TIMED_OUT ? ["沒有在時限內結束", ...scenario.judge(calls, reply)] : scenario.judge(calls, reply);
	return { problems, held: outside?.held.length ?? 0, calls: calls.map((call) => call.tool), tasks: calls.filter((call) => call.tool === "tell_agent").map((call) => String(call.args.task).slice(0, 180)), reply, broken: calls.length === 0 || scenario.steps.length > 1 && !calls.some((call) => call.tool === "tell_agent") };
}

for (const model of models) {
	let passed = 0;
	let total = 0;
	for (const scenario of SCENARIOS.filter((item) => !only || item.name.startsWith(only))) {
		for (let index = 0; index < Number(runsArg); index++) {
			const result = run(scenario, model, index);
			if (!result.broken) total += 1;
			if (!result.broken && result.problems.length === 0) passed += 1;
			console.log(JSON.stringify({ model, scenario: scenario.name, broken: result.broken, ok: result.problems.length === 0, problems: result.problems, held: result.held, calls: result.calls, tasks: result.tasks, reply: result.reply.slice(-240) }));
		}
	}
	console.log(`${model}: ${passed}/${total}`);
}
