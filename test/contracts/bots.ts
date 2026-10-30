import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { AgentRuntime, ConversationId } from "../../src/agent/runtime.ts";
import { keepOpen, openRuntime, turn } from "./fixtures.ts";
import { browsers, type Check, faux, folders, settle } from "./setup.ts";

async function busyNow(runtime: AgentRuntime, id: ConversationId): Promise<boolean> {
	let busy = false;
	const stop = runtime.subscribeActivity((ids) => (busy = ids.has(id)));
	await settle();
	stop();
	return busy;
}

export const checks: Check[] = [
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
];
