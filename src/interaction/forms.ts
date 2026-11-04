import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, defineDoc, type Harness } from "@earendil-works/pi-durable";
import type { FormAnswer, FormRequest } from "../agent/mcp-stateless.ts";
import { checkpointEvery64 } from "../agent/doc-policy.ts";
import { orLogged } from "../promise.ts";

export type PendingForm = { conversationId: ConversationId; service: string; request: FormRequest; confirm?: string; accepted?: string };

export type Outcome = "accepted" | "declined" | "skipped" | "cancelled" | "unattended";

export type SettledForm = { step: string; service: string; message: string; outcome: Outcome; at: number; accepted?: string };

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

export type Presence = { unattended(conversationId: ConversationId): boolean; waiting(form: PendingForm): Promise<void> };

export class Forms {
	readonly #harness: Harness;
	readonly #presence: Presence;
	readonly #waiting = new Map<string, Waiting>();
	readonly #settled = new Map<string, readonly SettledForm[]>();
	readonly #listeners = new Set<() => void>();
	#state: FormsState = { pending: new Map(), settled: new Map() };

	constructor(harness: Harness, presence: Presence) {
		this.#harness = harness;
		this.#presence = presence;
	}

	ask(callId: string, form: PendingForm, signal: AbortSignal | undefined): Promise<FormAnswer> {
		if (signal?.aborted) return Promise.resolve({ action: "cancel" });
		if (this.#presence.unattended(form.conversationId)) {
			this.#keep(callId, form, "unattended");
			return Promise.resolve({ action: "cancel" });
		}
		return new Promise((resolve) => {
			const settle = (answer: FormAnswer, outcome: Outcome) => {
				signal?.removeEventListener("abort", cancel);
				this.#waiting.delete(callId);
				this.#changed();
				this.#keep(callId, form, outcome);
				resolve(answer);
			};
			const cancel = () => settle({ action: "cancel" }, "cancelled");
			signal?.addEventListener("abort", cancel, { once: true });
			this.#waiting.set(callId, { ...form, settle });
			this.#changed();
			void orLogged(this.#presence.waiting(form), "forms.notify_failed", undefined);
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

	#keep(callId: string, form: PendingForm, outcome: Outcome): void {
		void orLogged(this.#record(form.conversationId, { step: stepOf(callId), service: form.service, message: form.request.message, outcome, at: Date.now(), ...(form.accepted ? { accepted: form.accepted } : {}) }), "forms.record_failed", undefined);
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
