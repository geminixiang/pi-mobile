import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, defineDoc, type Harness } from "@earendil-works/pi-durable";
import type { FormAnswer, FormRequest } from "../agent/mcp-stateless.ts";
import { checkpointEvery64 } from "../agent/doc-policy.ts";
import { orLogged } from "../promise.ts";

export type PendingForm = { conversationId: ConversationId; service: string; request: FormRequest };

export type Outcome = "accepted" | "declined" | "skipped" | "cancelled";

export type SettledForm = { step: string; service: string; message: string; outcome: Outcome; at: number };

const KEPT = 100;

export const FormsDoc = defineDoc<{ settled: SettledForm[] }>({
	kind: "app.interaction.forms",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ settled: [] }),
	checkpointWhen: checkpointEvery64,
});

export const stepOf = (callId: string): string => callId.split("/")[0] ?? callId;

export type FormsState = { pending: ReadonlyMap<string, PendingForm>; settled: ReadonlyMap<string, readonly SettledForm[]> };

type Waiting = PendingForm & { settle: (answer: FormAnswer, outcome: Outcome) => void };

export class Forms {
	readonly #harness: Harness;
	readonly #waiting = new Map<string, Waiting>();
	readonly #settled = new Map<string, readonly SettledForm[]>();
	readonly #listeners = new Set<() => void>();
	#state: FormsState = { pending: new Map(), settled: new Map() };

	constructor(harness: Harness) {
		this.#harness = harness;
	}

	ask(callId: string, form: PendingForm, signal: AbortSignal | undefined): Promise<FormAnswer> {
		if (signal?.aborted) return Promise.resolve({ action: "cancel" });
		return new Promise((resolve) => {
			const settle = (answer: FormAnswer, outcome: Outcome) => {
				signal?.removeEventListener("abort", cancel);
				this.#waiting.delete(callId);
				this.#changed();
				void orLogged(this.#record(form.conversationId, { step: stepOf(callId), service: form.service, message: form.request.message, outcome, at: Date.now() }), "forms.record_failed", undefined);
				resolve(answer);
			};
			const cancel = () => settle({ action: "cancel" }, "cancelled");
			signal?.addEventListener("abort", cancel, { once: true });
			this.#waiting.set(callId, { ...form, settle });
			this.#changed();
		});
	}

	answer(callId: string, answer: FormAnswer): void {
		this.#waiting.get(callId)?.settle(answer, answer.action === "accept" ? "accepted" : answer.action === "decline" ? "declined" : "cancelled");
	}

	skip(conversationId: ConversationId): void {
		for (const waiting of [...this.#waiting.values()]) if (waiting.conversationId === conversationId) waiting.settle({ action: "cancel" }, "skipped");
	}

	async load(conversationId: ConversationId): Promise<void> {
		const doc = await this.#harness.snapshot(FormsDoc, conversationId, BACKGROUND_CONTEXT);
		this.#settled.set(String(conversationId), doc?.settled ?? []);
		this.#changed();
	}

	get state(): FormsState {
		return this.#state;
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async #record(conversationId: ConversationId, settled: SettledForm): Promise<void> {
		const next = await this.#harness.commit(async (tx) => {
			const doc = await tx.doc(FormsDoc, conversationId);
			const kept = [...doc.settled.map((record) => ({ ...record })), settled].slice(-KEPT);
			doc.settled = kept;
			return kept;
		}, BACKGROUND_CONTEXT);
		this.#settled.set(String(conversationId), next);
		this.#changed();
	}

	#changed(): void {
		const pending = new Map([...this.#waiting].map(([callId, { settle: _, ...form }]) => [callId, form]));
		this.#state = { pending, settled: new Map(this.#settled) };
		for (const listener of this.#listeners) listener();
	}
}
