import assert from "node:assert/strict";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { loadModels } from "../../src/agent/available-models.ts";
import { Forms, type PendingForm, type Presence } from "../../src/interaction/forms.ts";
import { context } from "./fixtures.ts";
import { type Check, settings, settle } from "./setup.ts";

async function fixture(presence: Partial<Presence>) {
	const { models } = await loadModels(settings, Promise.resolve({}));
	const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
	const { id } = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
	const { id: elsewhere } = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
	const told: string[] = [];
	const forms = new Forms(harness, { unattended: () => false, waiting: async (form) => void told.push(form.service), ...presence });
	const form: PendingForm = { conversationId: id, service: "Mail", request: { message: "send it?", schema: { type: "object", properties: {} } } };
	return { forms, form, id, elsewhere, told, close: () => harness.close(context) };
}

export const checks: Check[] = [
	[
		"a turn nobody is watching gets no card: it is told at once, and the conversation keeps the record",
		async () => {
			const { forms, form, id, told, close } = await fixture({ unattended: () => true });
			try {
				assert.deepEqual(await forms.ask("call-1/1", form, undefined), { action: "cancel" });
				assert.equal(forms.state.pending.size, 0);
				assert.deepEqual(told, []);
				await settle();
				await forms.load(id);
				assert.deepEqual((forms.state.settled.get(String(id)) ?? []).map((record) => record.outcome), ["unattended"]);
			} finally {
				await close();
			}
		},
	],
	[
		"a card in a turn the user started waits for them, and they are told it is waiting",
		async () => {
			const { forms, form, told, close } = await fixture({});
			try {
				const answered = forms.ask("call-1/1", form, undefined);
				assert.equal(forms.state.pending.size, 1);
				assert.deepEqual(told, ["Mail"]);
				forms.answer("call-1/1", { action: "decline" });
				assert.deepEqual(await answered, { action: "decline" });
				await settle();
			} finally {
				await close();
			}
		},
	],
	[
		"stopping the turn ends the card, and typing skips only that conversation's cards",
		async () => {
			const { forms, form, id, elsewhere, close } = await fixture({});
			try {
				const stop = new AbortController();
				const stopped = forms.ask("call-1/1", form, stop.signal);
				stop.abort();
				assert.deepEqual(await stopped, { action: "cancel" });
				assert.equal(forms.state.pending.size, 0);
				const other = forms.ask("call-2/1", { ...form, conversationId: elsewhere }, undefined);
				const mine = forms.ask("call-3/1", form, undefined);
				forms.skip(id);
				assert.deepEqual(await mine, { action: "cancel" });
				assert.deepEqual([...forms.state.pending.keys()], ["call-2/1"]);
				forms.answer("call-2/1", { action: "decline" });
				await other;
				await settle();
			} finally {
				await close();
			}
		},
	],
];
