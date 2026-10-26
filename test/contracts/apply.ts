import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Workplaces } from "../../src/agent/workplaces.ts";
import type { Host } from "../../src/agent/sandbox/host.ts";
import { agentState, idle, openRuntime } from "./fixtures.ts";
import { type Check, deferred, faux, platform, settings } from "./setup.ts";

const hostA: Host = { id: "a.example", address: "a.example", name: "A", os: "linux", arch: "arm64", user: "fixture", home: "/home/a", engine: "docker" };
const hostB: Host = { id: "b.example", address: "b.example", name: "B", os: "linux", arch: "arm64", user: "fixture", home: "/home/b" };

function thinkingOf(state: unknown): unknown {
	return state && typeof state === "object" && "thinkingLevel" in state ? state.thinkingLevel : undefined;
}

export const checks: Check[] = [
	[
		"a setting the runtime reads as it goes applies in place, with a turn still running",
		async () => {
			const { runtime } = await openRuntime();
			try {
				const [bot] = await runtime.bots();
				assert(bot);
				const modelAsked = deferred();
				const release = deferred();
				faux.setResponses([
					async () => {
						modelAsked.resolve();
						await release.promise;
						return fauxAssistantMessage("done after the setting changed");
					},
				]);
				const controller = await runtime.openConversation(bot.id);
				const done = idle(runtime, bot.id, 15_000);
				await controller.send([{ type: "text", text: "go" }]);
				await modelAsked.promise;
				assert.equal(await runtime.apply({ ...runtime.settings, defaultThinking: "high" }), "in_place");
				release.resolve();
				await done;
				let last = "";
				controller.subscribe((view) => {
					const entry = view.entries.findLast((candidate) => candidate.kind === "pi.assistant");
					last = JSON.stringify(entry ?? "");
				})();
				controller.dispose();
				assert(last.includes("done after the setting changed"), last);
				const created = await runtime.createBot({ name: "後來的", job: "", avatar: "🤖" });
				assert.equal(thinkingOf(await agentState(runtime, created)), "high");
			} finally {
				await runtime.close();
			}
		},
	],
	[
		"a change the harness was opened with asks for a restart and changes nothing",
		async () => {
			const { runtime } = await openRuntime();
			try {
				const before = runtime.settings;
				assert.equal(await runtime.apply({ ...before, githubToken: "ghp_new" }), "needs_restart");
				assert.equal(runtime.settings, before);
				assert.equal(await runtime.apply({ ...before, providerKeys: { ...before.providerKeys, faux: "other" } }), "needs_restart");
				assert.equal(runtime.settings, before);
			} finally {
				await runtime.close();
			}
		},
	],
	[
		"applying new computers keeps the sandbox of a computer that did not change and drops the others",
		async () => {
			const both = { ...settings, hosts: [hostA, hostB], hostKeys: { "a.example": "ka", "b.example": "kb" }, computer: "a.example:container" };
			const placed = new Map([
				["onA", { folder: "onA", computer: "a.example:container" }],
				["onB", { folder: "onB", computer: "b.example:direct" }],
			]);
			const workplaces = new Workplaces(both, {}, platform.phone, (id) => placed.get(id));
			try {
				const a = workplaces.at("onA");
				const b = workplaces.at("onB");
				assert(a?.kind === "computer" && b?.kind === "computer");
				workplaces.apply({ ...both, hosts: [hostA], hostKeys: { "a.example": "ka" } });
				const aAfter = workplaces.at("onA");
				assert(aAfter?.kind === "computer");
				assert.equal(aAfter.sandbox, a.sandbox);
				assert.equal(aAfter.host, a.host);
				assert.deepEqual(workplaces.at("onB"), { kind: "missing", key: "b.example:direct" });
				assert.deepEqual(
					workplaces.list().map((computer) => computer.key),
					["phone", "a.example:direct", "a.example:container"],
				);
				workplaces.apply({ ...both, hosts: [hostA], hostKeys: { "a.example": "rotated" } });
				const rotated = workplaces.at("onA");
				assert(rotated?.kind === "computer");
				assert.notEqual(rotated.sandbox, a.sandbox);
				assert.equal(rotated.host.key, "rotated");
			} finally {
				workplaces.close();
			}
		},
	],
];
