import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Computers } from "../../src/agent/computers.ts";
import { openRuntime, toolResults, turn } from "./fixtures.ts";
import { type Check, settings } from "./setup.ts";

const host = { id: "b.example", address: "b.example", name: "B", os: "linux", arch: "arm64", user: "fixture", home: "/home/fixture" };

export const checks: Check[] = [
	[
		"a bot whose computer was removed does not move to another computer",
		async () => {
			const computers = new Computers({ ...settings, hosts: JSON.stringify([host]), computer: "b.example:direct" }, {});
			assert.deepEqual(computers.resolve("a.example:container"), { kind: "missing", key: "a.example:container" });
			assert.equal(computers.sandboxAt(computers.resolve("a.example:container")), undefined);
			const inherited = computers.resolve(undefined);
			assert.equal(inherited.kind === "ready" && inherited.computer.key, "b.example:direct");
			const chosen = computers.resolve("phone");
			assert.equal(chosen.kind === "ready" && chosen.computer.key, "phone");
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
				assert.equal(runtime.offersComputers(bot.id), false);
				await runtime.setComputer(bot.id, "gone.example:direct");
				assert.equal(runtime.offersComputers(bot.id), true);
				assert.deepEqual(
					runtime.computers().map((computer) => computer.key),
					["phone"],
				);
			} finally {
				await runtime.close();
			}
		},
	],
];
