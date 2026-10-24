import assert from "node:assert/strict";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { loadModels } from "../../src/agent/available-models.ts";
import { LIMITS, type QueuedEvent, type Trigger, TRIGGER_ENTRY, TriggerDoc, TriggerRuns } from "../../src/agent/triggers.ts";
import { deliverEvents } from "../../src/app/triggers.ts";
import type { Judge, Verdict } from "../../src/agent/judge.ts";
import { context, entriesOf } from "./fixtures.ts";
import { type Check, logged, settings } from "./setup.ts";

const DAY = 24 * 60 * 60 * 1000;

async function triggerFixture(
	when: Trigger["when"],
	options: { enabled?: boolean; runs?: { trigger: string; at: number; request?: string }[]; onlyIf?: string; verdict?: Verdict } = {},
) {
	const storage = new MemoryStorage();
	const { models } = await loadModels(settings, Promise.resolve({}));
	const harness = await Harness.open(storage, { models, registry: createRegistry() }, context);
	const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
	await harness.commit(async (tx) => {
		const doc = await tx.doc(TriggerDoc);
		doc.items.push({
			id: "t1",
			name: "fixture",
			prompt: "fixture",
			when,
			...(options.onlyIf ? { onlyIf: options.onlyIf } : {}),
			kind: "schedule",
			conversationId: conversation.id,
			enabled: options.enabled ?? true,
			createdAt: Date.now(),
		});
		doc.runs = options.runs ?? [];
	}, context);
	let refuse = false;
	const flaky = new Proxy(harness, {
		get(target, key) {
			if (key === "conversation")
				return async (...args: Parameters<typeof target.conversation>) => {
					const found = await target.conversation(...args);
					if (!found || !refuse) return found;
					return new Proxy(found, {
						get(inner, name) {
							if (name === "submit") return async () => Promise.reject(new Error("submission refused"));
							const value: unknown = Reflect.get(inner, name, inner);
							return typeof value === "function" ? value.bind(inner) : value;
						},
					});
				};
			const value: unknown = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const touched: number[] = [];
	const asked: string[] = [];
	const judge: Judge = {
		ask: async (question) => {
			asked.push(question);
			return options.verdict ?? { kind: "unanswered", reason: "no judge in this fixture" };
		},
	};
	const runs = new TriggerRuns(flaky, async () => [{ id: conversation.id, avatar: "helper" }], async (_id, at) => void touched.push(at), judge);
	return {
		runs,
		touched,
		asked,
		conversation: conversation.id,
		doc: async () => (await harness.snapshot(TriggerDoc, context)) ?? { items: [], runs: [] },
		delivered: () => entriesOf(storage, conversation.id, TRIGGER_ENTRY),
		refuse: (value: boolean) => (refuse = value),
		close: () => harness.close(context),
	};
}

async function withTrigger(fixture: Awaited<ReturnType<typeof triggerFixture>>, run: () => Promise<void>): Promise<void> {
	try {
		await run();
	} finally {
		await fixture.close();
	}
}

const alarm = (id: string, at = Date.now()): QueuedEvent => ({ id, at, kind: "alarm", trigger: "t1", live: true });

export const checks: Check[] = [
	[
		"an event the judge finds unlikely wakes no one, is not counted, and says it was skipped",
		async () => {
			const fixture = await triggerFixture({ kind: "unlock", days: [], gapHours: 1 }, { onlyIf: "Is it morning?", verdict: { kind: "answered", probability: 0.1, model: "jev" } });
			await withTrigger(fixture, async () => {
				assert.equal(await fixture.runs.run("t1", "live", { event: "e1", device: "解鎖手機" }), undefined);
				assert.deepEqual(fixture.asked, ["Is it morning?"]);
				assert.equal(await fixture.delivered(), 0);
				const after = await fixture.doc();
				assert.equal(after.runs.length, 0);
				assert.equal(after.items[0]?.last?.skipped, true);
				assert.equal(after.items[0]?.last?.judged, 0.1);
				assert.deepEqual(fixture.touched, []);
			});
		},
	],
	[
		"an event the judge finds likely runs and keeps the probability",
		async () => {
			const fixture = await triggerFixture({ kind: "unlock", days: [], gapHours: 1 }, { onlyIf: "Is it morning?", verdict: { kind: "answered", probability: 0.9, model: "jev" } });
			await withTrigger(fixture, async () => {
				assert.ok(await fixture.runs.run("t1", "live", { event: "e1", device: "解鎖手機" }));
				assert.equal(await fixture.delivered(), 1);
				const after = await fixture.doc();
				assert.equal(after.runs.length, 1);
				assert.equal(after.items[0]?.last?.judged, 0.9);
				assert.equal(after.items[0]?.last?.skipped, undefined);
			});
		},
	],
	[
		"an event the judge cannot answer runs anyway and says it was not checked; a manual run asks nothing",
		async () => {
			const fixture = await triggerFixture({ kind: "unlock", days: [], gapHours: 1 }, { onlyIf: "Is it morning?" });
			await withTrigger(fixture, async () => {
				assert.ok(await fixture.runs.run("t1", "live", { event: "e1", device: "解鎖手機" }));
				assert.match((await fixture.doc()).items[0]?.last?.unjudged ?? "", /no judge/);
				assert.ok(await fixture.runs.run("t1", "manual"));
				assert.equal(fixture.asked.length, 1);
				assert.equal(await fixture.delivered(), 2);
			});
		},
	],
	[
		"a one-time schedule whose input was refused is still there to retry, says so, and is not armed again",
		async () => {
			const fixture = await triggerFixture({ kind: "once", at: Date.now() - 1000 });
			await withTrigger(fixture, async () => {
				fixture.refuse(true);
				await assert.rejects(fixture.runs.run("t1", "live", { event: "e1" }), /submission refused/);
				const after = await fixture.doc();
				assert.equal(after.items.length, 1);
				assert.equal(after.items[0]?.fired, true);
				assert.match(after.items[0]?.last?.error ?? "", /會再試/);
				assert.equal(after.runs.length, 0);
				assert.equal(fixture.runs.takeStarted(fixture.conversation), false);
				assert.deepEqual(fixture.touched, []);
				fixture.refuse(false);
				assert.ok(await fixture.runs.run("t1", "later", { event: "e1" }));
				assert.equal((await fixture.doc()).items.length, 0);
				assert.equal((await fixture.doc()).runs.length, 1);
				assert.equal(await fixture.delivered(), 1);
			});
		},
	],
	[
		"an event delivered twice is one input and one run",
		async () => {
			const fixture = await triggerFixture({ kind: "daily", time: "08:00", days: [] });
			await withTrigger(fixture, async () => {
				await fixture.runs.run("t1", "live", { event: "e1" });
				assert.equal(fixture.runs.takeStarted(fixture.conversation), true);
				await fixture.runs.run("t1", "live", { event: "e1" });
				assert.equal(await fixture.delivered(), 1);
				assert.equal((await fixture.doc()).runs.length, 1);
				assert.equal(fixture.runs.takeStarted(fixture.conversation), false);
			});
		},
	],
	[
		"an event delivered again after it filled the day's limit is not reported as over the limit",
		async () => {
			const today = Date.now();
			const runs = Array.from({ length: LIMITS.perTrigger }, (_, at) => ({ trigger: "t1", at: today - at, request: `trigger:e${at}` }));
			const fixture = await triggerFixture({ kind: "daily", time: "08:00", days: [] }, { runs });
			await withTrigger(fixture, async () => {
				assert.ok(await fixture.runs.run("t1", "live", { event: "e0" }));
				const after = await fixture.doc();
				assert.equal(after.runs.length, LIMITS.perTrigger);
				assert.equal(after.items[0]?.last, undefined);
			});
		},
	],
	[
		"an event from yesterday delivered again today is not counted again",
		async () => {
			const fixture = await triggerFixture({ kind: "daily", time: "08:00", days: [] }, { runs: [{ trigger: "t1", at: Date.now() - DAY, request: "trigger:old" }] });
			await withTrigger(fixture, async () => {
				await fixture.runs.run("t1", "live", { event: "new" });
				await fixture.runs.run("t1", "live", { event: "old" });
				assert.deepEqual(
					(await fixture.doc()).runs.map((run) => run.request),
					["trigger:old", "trigger:new"],
				);
				assert.equal(await fixture.delivered(), 1);
			});
		},
	],
	[
		"an event queued before its schedule was paused does not run",
		async () => {
			const fixture = await triggerFixture({ kind: "daily", time: "08:00", days: [] }, { enabled: false });
			await withTrigger(fixture, async () => {
				assert.equal(await fixture.runs.run("t1", "later", { event: "e1" }), undefined);
				assert.equal(await fixture.delivered(), 0);
				assert.ok(await fixture.runs.run("t1", "manual"));
			});
		},
	],
	[
		"the event queue is acknowledged only for events handled, unreadable, or a day old",
		async () => {
			const now = Date.now();
			const dropped: string[] = [];
			logged.length = 0;
			const handled = await deliverEvents(
				{ events: [alarm("ok", now), alarm("fails", now), alarm("stale", now - 2 * DAY)], unreadable: ["garbled"] },
				async (event) => {
					if (event.id !== "ok") throw new Error("not now");
				},
				async (event) => void dropped.push(event.id),
				now,
			);
			assert.deepEqual(handled, ["garbled", "ok", "stale"]);
			assert.deepEqual(dropped, ["stale"]);
			assert.deepEqual(
				logged.map((entry) => [entry.event, entry.fields.id]),
				[
					["trigger.retry_later", "fails"],
					["trigger.dropped", "stale"],
				],
			);
		},
	],
];
