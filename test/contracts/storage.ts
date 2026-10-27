import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import type { ConversationId } from "../../src/agent/runtime.ts";
import { surviveSuspension } from "../../src/storage.ts";
import { entriesOf, keepOpen, openRuntime, turn } from "./fixtures.ts";
import type { Check } from "./setup.ts";

const SUSPENDED = "Attempt to get a record from database without an in-progress transaction";

function failingCommits(storage: MemoryStorage, failures: number): MemoryStorage {
	let left = failures;
	return new Proxy(storage, {
		get(target, key) {
			const value: unknown = Reflect.get(target, key, target);
			if (typeof value !== "function") return value;
			if (key !== "commit") return value.bind(target);
			return (...args: unknown[]) => (left-- > 0 ? Promise.reject(new Error(SUSPENDED)) : Reflect.apply(value, target, args));
		},
	});
}

async function withBot(): Promise<{ memory: MemoryStorage; bot: ConversationId }> {
	const memory = keepOpen(new MemoryStorage());
	const { runtime } = await openRuntime(memory);
	const bot = await runtime.createBot({ name: "tmp", job: "", avatar: "helper" });
	await runtime.close();
	return { memory, bot };
}

const answers = (memory: MemoryStorage, bot: ConversationId) => entriesOf(memory, bot, "pi.assistant");

const open = async (storage: Storage) => (await openRuntime(storage)).runtime;

export const checks: Check[] = [
	[
		"a commit WebKit aborts as pi goes to the background is retried, and the turn finishes",
		async () => {
			const { memory, bot } = await withBot();
			const runtime = await open(surviveSuspension(failingCommits(memory, 1)));
			try {
				await turn(runtime, bot, [fauxAssistantMessage("after")]);
				assert.equal(await answers(memory, bot), 1);
			} finally {
				await runtime.close();
			}
		},
	],
	[
		"a storage error that is not retried ends the runtime as failed, and reopening continues from what was committed",
		async () => {
			const { memory, bot } = await withBot();
			const failing = await open(failingCommits(memory, 1));
			const controller = await failing.openConversation(bot);
			await assert.rejects(controller.send([{ type: "text", text: "lost" }]), /without an in-progress transaction/);
			const end = await failing.closed;
			assert.equal(end.reason, "failed");
			controller.dispose();
			await failing.close();
			const reopened = await open(memory);
			try {
				assert.ok((await reopened.bots()).some((candidate) => candidate.id === bot));
				await turn(reopened, bot, [fauxAssistantMessage("back")]);
				assert.equal(await answers(memory, bot), 1);
			} finally {
				await reopened.close();
			}
		},
	],
];
