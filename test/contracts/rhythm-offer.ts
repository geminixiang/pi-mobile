import assert from "node:assert/strict";
import { createModels, fauxAssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { memoryCredentials } from "../../src/agent/credentials.ts";
import { BotIndex } from "../../src/agent/bots.ts";
import { keepOpen, openRuntime, turn } from "./fixtures.ts";
import type { Check } from "./setup.ts";

const OFFER = "要我每天早上給你簡報嗎？";

export const checks: Check[] = [
	[
		"a new bot offers the morning brief in its first two replies to the user and then never again",
		async () => {
			const { runtime } = await openRuntime();
			try {
				const bot = await runtime.createBot({ name: "new", job: "", avatar: "helper" });
				const stateAfter = async () => (await runtime.bots()).find((candidate) => candidate.id === bot)?.rhythmOffer;
				assert.equal(await stateAfter(), "unsent");
				let first = "";
				await turn(runtime, bot, [
					(context: TranscriptContext) => {
						first = JSON.stringify(context);
						return fauxAssistantMessage("done");
					},
				]);
				assert.ok(first.includes(OFFER), "the first reply is told to offer it");
				assert.equal(await stateAfter(), "open");
				await turn(runtime, bot, [() => fauxAssistantMessage("done")]);
				assert.equal(await stateAfter(), "last");
				await turn(runtime, bot, [() => fauxAssistantMessage("done")]);
				assert.equal(await stateAfter(), undefined, "after the second reply the offer is gone for good");
			} finally {
				await runtime.close();
			}
		},
	],
	[
		"a bot from before the offer is never offered the morning brief",
		async () => {
			const storage = keepOpen(new MemoryStorage());
			const before = await openRuntime(storage);
			const bot = await before.runtime.createBot({ name: "old", job: "", avatar: "helper" });
			await before.runtime.close();
			const raw = await Harness.open(storage, { models: createModels({ credentials: memoryCredentials({}, {}, () => undefined) }), registry: createRegistry(), settings: { extensions: [] } }, BACKGROUND_CONTEXT);
			await raw.commit(async (tx) => {
				const stored = (await tx.doc(BotIndex)).items.find((candidate) => candidate.id === bot);
				if (stored) delete stored.rhythmOffer;
			}, BACKGROUND_CONTEXT);
			await raw.close(BACKGROUND_CONTEXT);
			const { runtime } = await openRuntime(storage);
			try {
				let prompt = "";
				await turn(runtime, bot, [
					(context: TranscriptContext) => {
						prompt = JSON.stringify(context);
						return fauxAssistantMessage("done");
					},
				]);
				assert.ok(!prompt.includes(OFFER));
				assert.equal((await runtime.bots()).find((candidate) => candidate.id === bot)?.rhythmOffer, undefined);
			} finally {
				await runtime.close();
			}
		},
	],
	[
		"a schedule's run is not told to offer the morning brief, even while the offer is open",
		async () => {
			const { runtime } = await openRuntime();
			try {
				const bot = await runtime.createBot({ name: "new", job: "", avatar: "helper" });
				let prompt = "";
				await turn(
					runtime,
					bot,
					[
						(context: TranscriptContext) => {
							prompt = JSON.stringify(context.messages.at(-1));
							return fauxAssistantMessage("done");
						},
					],
					"[trigger] 早晨簡報\n\nRead the morning-brief skill and give today's brief.",
				);
				assert.ok(!prompt.includes(OFFER));
			} finally {
				await runtime.close();
			}
		},
	],
];
