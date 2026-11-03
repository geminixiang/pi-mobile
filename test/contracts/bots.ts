import assert from "node:assert/strict";
import { createModels, fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { memoryCredentials } from "../../src/agent/credentials.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import type { AgentRuntime, ConversationId } from "../../src/agent/runtime.ts";
import { freeAvatar } from "../../src/agent/bots.ts";
import type { Host } from "../../src/agent/sandbox/host.ts";
import { keepOpen, openRuntime, turn } from "./fixtures.ts";
import { browsers, type Check, faux, folders, logged, reports, settings, settle } from "./setup.ts";

async function busyNow(runtime: AgentRuntime, id: ConversationId): Promise<boolean> {
	let busy = false;
	const stop = runtime.subscribeActivity((ids) => (busy = ids.has(id)));
	await settle();
	stop();
	return busy;
}

export const checks: Check[] = [
	[
		"there is no limit on how many bots there are, and once every avatar is taken a new bot gets the least used one",
		async () => {
			const { runtime } = await openRuntime();
			try {
				for (let index = (await runtime.bots()).length; index < 14; index++) await runtime.createBot({ name: `bot${index}`, job: "", avatar: "helper" });
				assert.equal((await runtime.bots()).length, 14);
				const twice = (await runtime.bots()).filter((bot) => bot.avatar === "helper").length;
				assert.ok(twice >= 2);
				assert.notEqual(freeAvatar(await runtime.bots()), "helper");
			} finally {
				await runtime.close();
			}
		},
	],
	[
		"a bot that turned a toolset off under its old extension name finds it off after the rename",
		async () => {
			const storage = keepOpen(new MemoryStorage());
			const before = await openRuntime(storage);
			const bot = await before.runtime.createBot({ name: "tmp", job: "", avatar: "helper" });
			await before.runtime.close();
			const raw = await Harness.open(storage, { models: createModels({ credentials: memoryCredentials({}, {}, () => undefined) }), registry: createRegistry(), settings: { extensions: [] } }, BACKGROUND_CONTEXT);
			await (await raw.conversation(bot, BACKGROUND_CONTEXT))?.configure({ extensions: { add: [], remove: [{ name: "phone_screen" }, { name: "sandbox" }] } }, BACKGROUND_CONTEXT);
			await raw.close(BACKGROUND_CONTEXT);
			const after = await openRuntime(storage);
			try {
				const enabled = Object.fromEntries((await after.runtime.toolsets(bot)).map((toolset) => [toolset.id, toolset.enabled]));
				assert.equal(enabled.phone_as_user, false);
				assert.equal(enabled.computer_shell, false);
				assert.equal(enabled.web, true);
			} finally {
				await after.runtime.close();
			}
		},
	],
	[
		"removing a bot stops its work and takes its memory",
		async () => {
			const { runtime } = await openRuntime();
			try {
				const gone = await runtime.createBot({ name: "tmp", job: "", avatar: "helper" });
				await turn(runtime, gone, [
					fauxAssistantMessage(fauxToolCall("update_memory", { scope: "bot", new_text: "- fixture" }), { stopReason: "toolUse" }),
					fauxAssistantMessage("done"),
				]);
				assert.notEqual((await runtime.memory({ kind: "bot", id: gone })).text, "");
				const hold = Promise.withResolvers<void>();
				faux.setResponses([
					async (_context, options) => {
						const aborted = new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve()));
						await Promise.race([hold.promise, aborted]);
						return fauxAssistantMessage(options?.signal?.aborted ? "" : "late", options?.signal?.aborted ? { stopReason: "aborted" } : {});
					},
				]);
				const controller = await runtime.openConversation(gone);
				await controller.send([{ type: "text", text: "work" }]);
				await settle(50);
				assert.equal(await busyNow(runtime, gone), true);
				const removed = runtime.removeBot(gone);
				const finished = await Promise.race([removed.then(() => "removed"), settle(1000).then(() => "still removing")]);
				const busyAfter = await busyNow(runtime, gone);
				hold.resolve();
				await removed;
				controller.dispose();
				assert.equal(finished, "removed");
				assert.equal(busyAfter, false);
				assert.equal((await runtime.memory({ kind: "bot", id: gone })).text, "");
				assert.equal((await runtime.bots()).some((bot) => bot.id === gone), false);
			} finally {
				await runtime.close();
			}
		},
	],
	[
		"removing a bot takes its report off the home screen widget",
		async () => {
			const { runtime } = await openRuntime();
			try {
				const gone = await runtime.createBot({ name: "tmp", job: "", avatar: "helper" });
				reports.forgotten.length = 0;
				await runtime.removeBot(gone);
				assert.deepEqual(reports.forgotten, [String(gone)]);
			} finally {
				await runtime.close();
			}
		},
	],
	[
		"a bot being removed or removed takes no new input",
		async () => {
			const { runtime } = await openRuntime();
			try {
				const gone = await runtime.createBot({ name: "tmp", job: "", avatar: "helper" });
				const controller = await runtime.openConversation(gone);
				const gate = Promise.withResolvers<void>();
				folders.removeGate = gate;
				const removing = runtime.removeBot(gone);
				await settle();
				await assert.rejects(controller.send([{ type: "text", text: "late" }]), /已經刪除/);
				folders.removeGate = undefined;
				gate.resolve();
				await removing;
				await assert.rejects(controller.send([{ type: "text", text: "later" }]), /已經刪除/);
				controller.dispose();
			} finally {
				await runtime.close();
			}
		},
	],
	[
		"a removal cut short finishes the next time the app opens",
		async () => {
			const storage = keepOpen(new MemoryStorage());
			const first = await openRuntime(storage);
			const gone = await first.runtime.createBot({ name: "tmp", job: "", avatar: "helper" });
			const folder = (await first.runtime.bots()).find((bot) => bot.id === gone)?.folder;
			assert(folder);
			const gate = Promise.withResolvers<void>();
			folders.removeGate = gate;
			folders.removed.length = 0;
			const cut = first.runtime.removeBot(gone).then(
				() => "finished",
				() => "cut",
			);
			await settle();
			await first.runtime.close();
			folders.removeGate = undefined;
			gate.resolve();
			await cut;
			const second = await openRuntime(storage);
			try {
				await settle(100);
				assert.deepEqual(folders.removed, [folder, folder]);
				assert(browsers.forgotten.includes(String(gone)));
				assert.equal((await second.runtime.bots()).some((bot) => bot.id === gone), false);
				const third = (await second.runtime.bots()).length;
				assert.equal(third, 1);
			} finally {
				await second.runtime.close();
			}
		},
	],
	[
		"a bot whose folder on an unreachable computer cannot be cleared still leaves the list and the other bots' prompt at once, and its folder is tried again when the app opens, once per computer",
		async () => {
			const offline: Host = { id: "127.0.0.1", address: "127.0.0.1", name: "Offline", os: "linux", arch: "arm64", user: "fixture", home: "/home/fixture", engine: "docker" };
			const config = { hosts: [offline], computer: "" } satisfies Partial<typeof settings>;
			const failures = () => logged.filter((entry) => entry.event === "bot.remove_container_folder_failed").length;
			const storage = keepOpen(new MemoryStorage());
			const first = await openRuntime(storage, config);
			const keep = await first.runtime.createBot({ name: "keep", job: "", avatar: "helper" });
			for (const name of ["gone-one", "gone-two"]) await first.runtime.removeBot(await first.runtime.createBot({ name, job: "a job nobody does any more", avatar: "helper" }));
			await settle(100);
			let prompt = "";
			await turn(first.runtime, keep, [
				(context: TranscriptContext) => {
					prompt = JSON.stringify(context);
					return fauxAssistantMessage("done");
				},
			]);
			assert.deepEqual(
				(await first.runtime.bots()).map((bot) => bot.name).filter((name) => name.startsWith("gone")),
				[],
			);
			assert.equal(prompt.includes("gone-"), false);
			await first.runtime.close();
			const before = failures();
			const second = await openRuntime(storage, config);
			try {
				await settle(100);
				assert.equal(failures() - before, 1);
			} finally {
				await second.runtime.close();
			}
		},
	],
];
