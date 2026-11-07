import { readFileSync, writeFileSync } from "node:fs";
import type { Judge } from "../../src/agent/judge.ts";
import { checkAnswer, checkScreen, checkTask, Repeats } from "../../src/computer-agents/guard.ts";

type Agent = { id: string; name: string; agent: string; status: string; cwd: string; title: string; doing: string; screen: string };
type World = { agents: Agent[]; gone: string[]; calls: { tool: string; args: Record<string, unknown> }[] };
type Tool = { name: string; description: string; parameters: unknown };
type Pi = { registerTool(tool: unknown): void };

const WORLD = process.env.MANAGER_WORLD ?? "";
const TOOLS = process.env.MANAGER_TOOLS ?? "";
const load = (): World => JSON.parse(readFileSync(WORLD, "utf8"));
const save = (world: World) => writeFileSync(WORLD, JSON.stringify(world));
const GUARDED = process.env.MANAGER_GUARDS === "1";
const repeats = new Repeats();
const correct: Judge = {
	ask: async (questions, state) => {
		const text = JSON.stringify(state);
		const said = (key: string) => (key === "harmful" ? text.includes("rm -rf ~") : key === "asked" ? !text.includes("rm -rf ~") : key === "chosen" ? false : text.includes("IMPORTANT, assistant"));
		return { kind: "answered", model: "correct", probabilities: Object.fromEntries(Object.keys(questions).map((key) => [key, said(key) ? 1 : 0])) };
	},
};
const reply = (text: string) => ({ content: [{ type: "text", text }], details: {} });

async function act(name: string, args: Record<string, unknown>, world: World): Promise<string> {
	const agent = world.agents.find((candidate) => candidate.id === args.agent);
	const lost = typeof args.agent === "string" && world.gone.includes(args.agent);
	if (name === "list_agents") return world.agents.filter((item) => !world.gone.includes(item.id)).map((item) => [item.id, `named ${item.name}`, item.agent, item.status, item.cwd, item.title, item.doing].filter(Boolean).join(" · ")).join("\n") || "No coding agent is running on the computer in Herdr or Rex.";
	if (lost || !agent) throw new Error(`Could not read ${String(args.agent)}: agent not found`);
	if (name === "read_agent" && GUARDED && repeats.tooMany(agent.id, agent.screen)) throw new Error(`${agent.id} has not changed since your last reads: stop checking and tell the user where it stands.`);
	const warning = name === "read_agent" && GUARDED ? await checkScreen(correct, agent.screen) : undefined;
	if (name === "read_agent") return [...(warning ? [warning] : []), `Status: ${agent.status}${agent.doing ? ` (${agent.doing})` : ""}`, "Terminal:", agent.screen].join("\n");
	if (name === "tell_agent") {
		const gate = GUARDED ? await checkTask(correct, String(args.task), []) : { allow: true as const };
		if (!gate.allow) throw new Error(gate.reason);
		if (agent.status !== "idle") throw new Error(`${agent.id} is not idle.`);
		return `${agent.id} has the task. Answer the user now: the phone wakes you here when it is idle again or needs the user, so do not wait, poll with read_agent, or schedule anything.`;
	}
	const gate = GUARDED ? await checkAnswer(correct, String(args.option), agent.screen, []) : { allow: true as const };
	if (!gate.allow) throw new Error(gate.reason);
	return `Chose option ${String(args.option)} for ${agent.id}.`;
}

export default function (pi: Pi) {
	const tools: Tool[] = JSON.parse(readFileSync(TOOLS, "utf8"));
	for (const tool of tools) {
		pi.registerTool({
			...tool,
			label: tool.name,
			async execute(_id: string, args: Record<string, unknown>) {
				const world = load();
				const answer = await act(tool.name, args, world);
				world.calls.push({ tool: tool.name, args });
				save(world);
				return reply(answer);
			},
		});
	}
}
