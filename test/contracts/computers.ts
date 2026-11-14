import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { Workplaces } from "../../src/agent/workplaces.ts";
import type { Host } from "../../src/computer/pairing.ts";
import { openRuntime, toolResults, turn } from "./fixtures.ts";
import { type Check, logged, platform, settings, settle } from "./setup.ts";

const host: Host = { id: "b.example", address: "b.example", name: "B", os: "linux", arch: "arm64", user: "fixture", home: "/home/fixture" };

export const checks: Check[] = [
	[
		"resolving a container placement reaches the computer only when the bot uses it",
		async () => {
			const unreachable = { ...host, id: "127.0.0.1", address: "127.0.0.1", engine: "docker" };
			const config = { ...settings, hosts: [unreachable], computer: "127.0.0.1:container" };
			const workplaces = new Workplaces(config, {}, platform.phone, (id) => ({ folder: id }));
			const before = logged.length;
			try {
				const place = workplaces.at("bot");
				assert(place?.kind === "computer" && !place.sandbox.direct);
				await settle(300);
				assert.deepEqual(place.sandbox.status, { kind: "idle" });
				assert.deepEqual(
					logged.slice(before).map((entry) => entry.event),
					[],
				);
				await assert.rejects(place.env());
			} finally {
				workplaces.close();
			}
		},
	],
	[
		"unchanged computer resolution preserves the host used by preparation effects",
		async () => {
			const config = { ...settings, hosts: [host], computer: "b.example:direct" };
			const workplaces = new Workplaces(config, {}, platform.phone, (id) => ({ folder: id }));
			const replacement = new Workplaces({ ...config, hosts: [{ ...host, address: "new.example" }] }, {}, platform.phone, (id) => ({ folder: id }));
			try {
				const first = workplaces.at("first");
				assert(first?.kind === "computer");
				for (let i = 0; i < 100; i++) {
					const next = workplaces.at(`bot-${i}`);
					assert(next?.kind === "computer");
					assert.equal(next.host, first.host);
					assert.equal(next.sandbox, first.sandbox);
				}
				const changed = replacement.at("first");
				assert(changed?.kind === "computer");
				assert.notEqual(changed.host, first.host);
				assert.equal(changed.host.address, "new.example");
				assert.equal(first.host.address, "b.example");
			} finally {
				workplaces.close();
				replacement.close();
			}
		},
	],
	[
		"a bot whose computer was removed does not move to another computer",
		async () => {
			const bots = new Map([
				["gone", { folder: "f1", computer: "a.example:container" }],
				["inherits", { folder: "f2" }],
				["phone", { folder: "f3", computer: "phone" }],
			]);
			const workplaces = new Workplaces({ ...settings, hosts: [host], computer: "b.example:direct" }, {}, platform.phone, (id) => bots.get(id));
			try {
				assert.deepEqual(workplaces.at("gone"), { kind: "missing", key: "a.example:container" });
				const inherited = workplaces.at("inherits");
				assert.equal(inherited?.kind === "computer" && inherited.computer.key, "b.example:direct");
				const phone = workplaces.at("phone");
				assert.equal(phone?.kind, "phone");
				assert.equal(workplaces.at("unknown"), undefined);
			} finally {
				workplaces.close();
			}
		},
	],
	[
		"a bot whose computer was removed keeps every tool but the file tools, without a report each turn",
		async () => {
			const { runtime, reports, storage } = await openRuntime();
			try {
				const [bot] = await runtime.bots();
				assert(bot);
				await runtime.setComputer(bot.id, "gone.example:container");
				await turn(runtime, bot.id, [
					fauxAssistantMessage([fauxToolCall("update_memory", { scope: "bot", new_text: "- fixture" }), fauxToolCall("bash", { command: "ls" })], { stopReason: "toolUse" }),
					fauxAssistantMessage("done"),
				]);
				const results = await toolResults(storage, bot.id);
				assert.equal(results.find((result) => result.name === "update_memory")?.isError, false);
				assert.equal(results.find((result) => result.name === "bash")?.isError, true);
				assert.deepEqual(reports, []);
				assert.equal((await runtime.memory({ kind: "bot", id: bot.id })).text.includes("fixture"), true);
			} finally {
				await runtime.close();
			}
		},
	],
	[
		"a bot whose computer was removed can still be given another, even with no computer left",
		async () => {
			const { runtime } = await openRuntime();
			try {
				const [bot] = await runtime.bots();
				assert(bot);
				assert.equal(runtime.workplaces.offers(String(bot.id)), false);
				await runtime.setComputer(bot.id, "gone.example:direct");
				assert.equal(runtime.workplaces.offers(String(bot.id)), true);
				assert.deepEqual(
					runtime.workplaces.list().map((computer) => computer.key),
					["phone"],
				);
			} finally {
				await runtime.close();
			}
		},
	],
	[
		"a computer's toolsets are available only to a bot on a computer, and the phone's folder only to a bot on the phone",
		async () => {
			const availability = async (overrides: Partial<typeof settings>) => {
				const { runtime } = await openRuntime(undefined, overrides);
				try {
					const [bot] = await runtime.bots();
					assert(bot);
					return Object.fromEntries((await runtime.toolsets(bot.id)).filter((toolset) => ["files", "computer_shell", "computer_as_user", "computer_agents"].includes(toolset.id)).map((toolset) => [toolset.id, toolset.available]));
				} finally {
					await runtime.close();
				}
			};
			assert.deepEqual(await availability({}), { files: true, computer_shell: false, computer_as_user: false, computer_agents: false });
			assert.deepEqual(await availability({ hosts: [host], computer: "b.example:direct" }), { files: false, computer_shell: true, computer_as_user: true, computer_agents: true });
		},
	],
	[
		"a bot on a computer is told about the computer's tools",
		async () => {
			const { runtime } = await openRuntime(undefined, { hosts: [host], computer: "b.example:direct" });
			try {
				const bot = await runtime.createBot({ name: "tmp", job: "", avatar: "helper" });
				let offered = "";
				await turn(runtime, bot, [
					(context: TranscriptContext) => {
						offered = JSON.stringify(context);
						return fauxAssistantMessage("done");
					},
				]);
				for (const tool of ["computer_read_as_user", "computer_act_as_user", "tell_agent"]) assert.match(offered, new RegExp(`\\b${tool}\\b`), tool);
			} finally {
				await runtime.close();
			}
		},
	],
];
