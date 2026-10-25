import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Workplaces } from "../../src/agent/workplaces.ts";
import { openRuntime, toolResults, turn } from "./fixtures.ts";
import { type Check, platform, settings } from "./setup.ts";

const host = { id: "b.example", address: "b.example", name: "B", os: "linux", arch: "arm64", user: "fixture", home: "/home/fixture" };

export const checks: Check[] = [
	[
		"unchanged computer resolution preserves the host used by preparation effects",
		async () => {
			const config = { ...settings, hosts: JSON.stringify([host]), computer: "b.example:direct" };
			const workplaces = new Workplaces(config, {}, platform.phone, (id) => ({ folder: id }));
			const replacement = new Workplaces({ ...config, hosts: JSON.stringify([{ ...host, address: "new.example" }]) }, {}, platform.phone, (id) => ({ folder: id }));
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
			const workplaces = new Workplaces({ ...settings, hosts: JSON.stringify([host]), computer: "b.example:direct" }, {}, platform.phone, (id) => bots.get(id));
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
];
