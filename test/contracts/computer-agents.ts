import assert from "node:assert/strict";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import wire from "../../host/protocol.json" with { type: "json" };
import { agentState, createComputerAgentsExtension } from "../../src/computer-agents/tool.ts";
import { type Dial, HostCommands } from "../../src/computer/commands.ts";
import type { PairedHost } from "../../src/computer/pairing.ts";
import type { Workplace } from "../../src/agent/workplaces.ts";
import type { Check } from "./setup.ts";

// why: the tool reads only conversationId from its api; a whole Harness is not what this check is about
const api = { conversationId: "bot-1" } as unknown as ToolExecutionApi;

function answerAgent(unattended: boolean) {
	const reached: string[] = [];
	const extension = createComputerAgentsExtension({
		workplaces: {
			at: (conversation) => {
				reached.push(conversation);
				return undefined;
			},
			hosts: () => [],
		},
		triggers: { changed: () => undefined, unattended: () => unattended, notify: async () => "off" },
		userSaid: async () => [],
	});
	const tool = extension.tools?.find((candidate) => candidate.name === "answer_agent");
	assert(tool, "answer_agent exists");
	return { reached, answer: () => tool.execute({ agent: "herdr:default:w1:p1", option: 1 }, api, BACKGROUND_CONTEXT) };
}

const computer = (name: string, address: string): PairedHost => ({ id: address, name, address, os: "darwin", arch: "arm64", user: "me", home: "/Users/me", key: "k" });
const MINI = computer("Mac mini", "geminixiangmac-mini.tail1.ts.net");
const AIR = computer("MacBook Air", "geminixiangmacbook-air.tail1.ts.net");
const herdrAgent = { agent: "claude", agent_status: "blocked", cwd: "/Users/me/app", name: "tester", pane_id: "w1:p1", terminal_title_stripped: "Claude Code" };
const encoder = new TextEncoder();

function computers(answer: (address: string, command: string) => string | undefined): { dial: Dial; asked: string[] } {
	const asked: string[] = [];
	const dial: Dial = {
		network: { online: () => true, onChange: () => () => undefined },
		open: async (url, _what, onMessage) => {
			const said = answer(url.hostname, url.searchParams.get("command") ?? "");
			asked.push(url.hostname);
			if (said !== undefined)
				setTimeout(() => {
					onMessage(new Uint8Array([wire.stdout, ...encoder.encode(said)]).buffer);
					onMessage(JSON.stringify({ exit: 0 }));
				}, 0);
			return { send: () => undefined, close: () => undefined };
		},
	};
	return { dial, asked };
}

// why: the agents read only the host of a computer workplace; its sandbox and env are not what these checks are about
const onMini = { at: () => ({ kind: "computer", host: MINI }) as unknown as Workplace, hosts: () => [MINI, AIR] };

function listOnMini(dial: Dial) {
	const extension = createComputerAgentsExtension({ workplaces: onMini, triggers: { changed: () => undefined, unattended: () => false, notify: async () => "off" }, userSaid: async () => [], dial });
	const tool = extension.tools?.find((candidate) => candidate.name === "list_agents");
	assert(tool, "list_agents exists");
	return tool.execute({}, api, BACKGROUND_CONTEXT);
}

const textOf = (result: unknown) => JSON.stringify(result);

export const checks: Check[] = [
	[
		"list_agents asks every paired computer at once, names each agent with its computer, and a computer that does not answer is one line instead of failing the list",
		async () => {
			const { dial, asked } = computers((address) => (address === MINI.address ? `@@herdr default\n${JSON.stringify({ result: { agents: [herdrAgent] } })}\n` : undefined));
			const started = Date.now();
			const listed = textOf(await listOnMini(dial));
			assert.ok(Date.now() - started < 8_000, "a silent computer costs the wait, not the call");
			assert.deepEqual(asked.toSorted(), [MINI.address, AIR.address].toSorted());
			assert.ok(listed.includes("geminixiangmac-mini/herdr:default:w1:p1 · named tester · claude · needs_user · /Users/me/app · Claude Code"), listed);
			assert.ok(listed.includes("geminixiangmacbook-air (MacBook Air) did not answer"), listed);
		},
	],
	[
		"the watch on an agent id with a computer asks that computer, not the one the bot works on, and an id without one still means the bot's own computer",
		async () => {
			const { dial, asked } = computers(() => `${JSON.stringify({ result: { agent: herdrAgent } })}\n@@screen\nDo you want to proceed?\n`);
			const state = (agent: string) => agentState(onMini, "bot-1", agent, (host) => new HostCommands(host, dial));
			assert.equal(await state("geminixiangmacbook-air/herdr:default:w1:p1"), "needs_user");
			assert.equal(await state("herdr:default:w1:p1"), "needs_user");
			assert.deepEqual(asked, [AIR.address, MINI.address]);
			assert.equal(await state("office-pc/herdr:default:w1:p1"), "gone", "a computer no longer paired cannot bring the agent back");
		},
	],
	[
		"a turn started by a schedule cannot answer an agent's question, and never reaches the computer: a notification must not be able to approve a command",
		async () => {
			const { reached, answer } = answerAgent(true);
			await assert.rejects(answer(), /started from a schedule/);
			assert.deepEqual(reached, []);
		},
	],
	[
		"a turn the user started does reach for the computer",
		async () => {
			const { reached, answer } = answerAgent(false);
			await assert.rejects(answer(), /works on the phone/);
			assert.deepEqual(reached, ["bot-1"]);
		},
	],
];
