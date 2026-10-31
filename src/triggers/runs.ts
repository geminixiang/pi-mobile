import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Value } from "typebox/value";
import { type ConversationId, defineDoc, type Harness } from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";
import { native } from "../native.ts";
import { checkpointEvery64 } from "../agent/doc-policy.ts";
import { DAY, startOfToday } from "../agent/tools/common.ts";
import { check, oneOf, valueOrThrow } from "../agent/parse.ts";
import { messageOf, orLogged } from "../promise.ts";
import { entryText } from "../agent/entries.ts";
import type { Judge } from "../agent/judge.ts";
import { GUARD_IDS, type GuardId, screen, screeningQuestions } from "../agent/guards.ts";
import { Triggers, When } from "./plugin.ts";
import { isEvent } from "./when.ts";

const DELIVERIES = ["live", "later", "manual"] as const;
type Delivery = (typeof DELIVERIES)[number];

export type Confidence = { kind: "judged"; probability: number } | { kind: "unjudged"; reason: string };

export type LastRun = { at: number; delivery: Delivery } & (
	| { outcome: "ran"; confidence?: Confidence }
	| { outcome: "skipped"; reason: string; confidence?: Confidence }
	| { outcome: "failed"; error: string }
);

export type Trigger = {
	id: string;
	name: string;
	prompt: string;
	when: When;
	onlyIf?: string;
	guards?: GuardId[];
	kind: "schedule" | "followup";
	conversationId: ConversationId;
	state: "on" | "paused" | "fired";
	createdAt: number;
	last?: LastRun;
};

const V1Trigger = Type.Object({
	id: Type.String(),
	name: Type.String(),
	prompt: Type.String(),
	when: When,
	onlyIf: Type.Optional(Type.String()),
	guards: Type.Optional(Type.Array(oneOf(GUARD_IDS))),
	kind: oneOf(["schedule", "followup"]),
	conversationId: Type.Unsafe<ConversationId>(Type.Integer()),
	enabled: Type.Boolean(),
	fired: Type.Optional(Type.Boolean()),
	createdAt: Type.Number(),
	last: Type.Optional(
		Type.Object({
			at: Type.Number(),
			delivery: oneOf(DELIVERIES),
			error: Type.Optional(Type.String()),
			judged: Type.Optional(Type.Number()),
			unjudged: Type.Optional(Type.String()),
			skipped: Type.Optional(Type.Object({ reason: Type.String(), probability: Type.Optional(Type.Number()) })),
		}),
	),
});
const V1Doc = Type.Object({ items: Type.Array(V1Trigger), runs: Type.Array(Type.Object({ trigger: Type.String(), at: Type.Number(), request: Type.Optional(Type.String()) })) });

export const TriggerDoc = defineDoc<{ items: Trigger[]; runs: { trigger: string; at: number; request?: string }[] }>({
	kind: "app.triggers",
	version: 2,
	scope: "session",
	initial: () => ({ items: [], runs: [] }),
	migrate: (value) => {
		const v1 = valueOrThrow(check(V1Doc, value, "第 1 版的排程"));
		return { items: v1.items.map(fromV1), runs: v1.runs };
	},
	checkpointWhen: checkpointEvery64,
});

function fromV1({ enabled, fired, last, ...rest }: Static<typeof V1Trigger>): Trigger {
	const trigger: Trigger = { ...rest, state: !enabled ? "paused" : fired ? "fired" : "on" };
	if (!last) return trigger;
	const base = { at: last.at, delivery: last.delivery };
	const unjudged: { confidence?: Confidence } = last.unjudged !== undefined ? { confidence: { kind: "unjudged", reason: last.unjudged } } : {};
	if (last.error !== undefined) return { ...trigger, last: { ...base, outcome: "failed", error: last.error } };
	if (last.skipped) {
		const { reason, probability } = last.skipped;
		return { ...trigger, last: { ...base, outcome: "skipped", reason, ...(probability !== undefined ? { confidence: { kind: "judged", probability } } : unjudged) } };
	}
	return { ...trigger, last: { ...base, outcome: "ran", ...(last.judged !== undefined ? { confidence: { kind: "judged", probability: last.judged } } : unjudged) } };
}

export const LIMITS = { perTrigger: 10, total: 30 };

export const TRIGGER_ENTRY = "trigger.run";
const TriggerEntryData = Type.Object({
	trigger: Type.String(),
	name: Type.String(),
	prompt: Type.String(),
	kind: Type.String(),
	delivery: Type.String(),
	at: Type.Optional(Type.Number()),
	device: Type.Optional(Type.String()),
	on: Type.Optional(Type.String()),
	activity: Type.Optional(Type.String()),
	judged: Type.Optional(Type.Number()),
});

export type TriggerRun = Static<typeof TriggerEntryData>;

export function triggerRun(entry: { kind: string; data?: unknown }): TriggerRun | undefined {
	return entry.kind === TRIGGER_ENTRY && Value.Check(TriggerEntryData, entry.data) ? entry.data : undefined;
}

export interface TriggerState {
	items: Trigger[];
	next: Record<string, number>;
}

const RUNS_KEPT_MS = DAY;

const context = BACKGROUND_CONTEXT;

export class TriggerRuns {
	readonly #harness: Harness;
	readonly #bots: () => Promise<readonly { id: ConversationId; name: string; avatar: string }[]>;
	readonly #touchBot: (id: ConversationId, at: number) => Promise<void>;
	readonly #judge: Judge;
	readonly #listeners = new Set<(state: TriggerState) => void>();
	#state: TriggerState = { items: [], next: {} };
	readonly #started = new Map<ConversationId, string>();

	constructor(
		harness: Harness,
		bots: () => Promise<readonly { id: ConversationId; name: string; avatar: string }[]>,
		touchBot: (id: ConversationId, at: number) => Promise<void>,
		judge: Judge,
	) {
		this.#harness = harness;
		this.#bots = bots;
		this.#touchBot = touchBot;
		this.#judge = judge;
	}

	removeBot(conversationId: ConversationId): Promise<void> {
		return this.#edit((items) => items.filter((item) => item.conversationId !== conversationId));
	}

	subscribe(listener: (state: TriggerState) => void): () => void {
		this.#listeners.add(listener);
		listener(this.#state);
		return () => this.#listeners.delete(listener);
	}

	async sync(): Promise<void> {
		const items = (await this.#harness.snapshot(TriggerDoc, context))?.items ?? [];
		const avatars = new Map((await this.#bots()).map((bot) => [bot.id, bot.avatar]));
		const schedules = items
			.filter((item) => item.state === "on")
			.map(({ id, name, when, conversationId }) => ({ id, name, when, avatar: avatars.get(conversationId) }));
		const next = native.implements(Triggers.sync) ? (await Triggers.sync({ schedules })).next : {};
		this.#state = { items: [...items], next };
		for (const listener of this.#listeners) listener(this.#state);
	}

	async #edit(edit: (items: Trigger[]) => Trigger[]): Promise<void> {
		await this.#harness.commit(async (tx) => {
			const doc = await tx.doc(TriggerDoc);
			doc.items = edit(doc.items);
		}, context);
		await this.sync();
	}

	setPaused(id: string, paused: boolean): Promise<void> {
		return this.#edit((items) => items.map((item) => (item.id !== id ? item : { ...item, state: paused ? "paused" : item.state === "paused" ? "on" : item.state })));
	}

	setGuards(id: string, guards: readonly GuardId[]): Promise<void> {
		return this.#edit((items) =>
			items.map((item) => {
				if (item.id !== id) return item;
				const { guards: _old, ...rest } = item;
				return guards.length > 0 ? { ...rest, guards: [...guards] } : rest;
			}),
		);
	}

	delete(id: string): Promise<void> {
		return this.#edit((items) => items.filter((item) => item.id !== id));
	}

	async run(id: string, delivery: Delivery, delivered: { device?: string; event?: string } = {}): Promise<ConversationId | undefined> {
		const request = delivered.event ? `trigger:${delivered.event}` : undefined;
		const doc = await this.#harness.snapshot(TriggerDoc, context);
		const trigger = doc?.items.find((item) => item.id === id);
		if (request && doc?.runs.some((run) => run.request === request)) {
			await this.sync();
			return trigger?.conversationId;
		}
		if (!trigger || (delivery !== "manual" && trigger.state === "paused")) return undefined;
		if (trigger.when.kind === "once" && delivery !== "manual" && trigger.state === "on") await this.#markFired(id);
		const today = startOfToday();
		const runsToday = (doc?.runs ?? []).filter((run) => run.at >= today);
		const overLimit =
			delivery !== "manual" &&
			(runsToday.filter((run) => run.trigger === id).length >= LIMITS.perTrigger || runsToday.length >= LIMITS.total);
		const conversation = !overLimit && (await this.#bots()).some((bot) => bot.id === trigger.conversationId) ? await this.#harness.conversation(trigger.conversationId, context) : undefined;
		const now = Date.now();
		if (!conversation) {
			await this.#record(id, { at: now, delivery, outcome: "failed", error: overLimit ? "今天的執行次數已達上限" : "它的 Bot 已經刪除" });
			return undefined;
		}
		const conversationId = trigger.conversationId;
		const event = isEvent(trigger.when) && delivery !== "manual";
		const heard = event ? (delivered.device ?? trigger.when.kind) : undefined;
		const guards = trigger.guards ?? [];
		const screening =
			heard && (guards.length > 0 || trigger.onlyIf)
				? screen(guards, trigger.onlyIf, await this.#judge.ask(screeningQuestions(guards, trigger.onlyIf), { automation: trigger.name, purpose: trigger.prompt, event: heard }))
				: undefined;
		const probability = screening?.pass ? screening.judged : screening?.probability;
		const confidence: { confidence?: Confidence } =
			probability !== undefined ? { confidence: { kind: "judged", probability } } : screening?.unjudged ? { confidence: { kind: "unjudged", reason: screening.unjudged } } : {};
		if (screening && !screening.pass) {
			await this.#record(id, { at: now, delivery, outcome: "skipped", reason: screening.reason, ...confidence });
			if (native.implements(Triggers.skipped)) await Triggers.skipped({ trigger: id });
			return undefined;
		}
		const judged: { judged?: number } = screening?.judged !== undefined ? { judged: screening.judged } : {};
		const judgement = screening ? `, ${screening.note}` : "";
		const label =
			trigger.kind === "followup"
				? "follow-up you scheduled"
				: heard
					? `schedule "${trigger.name}": ${trigger.when.kind === "headphones" ? `headphones connected (${heard})` : heard}${judgement}`
					: `schedule "${trigger.name}"`;
		const activity: Record<string, string> = trigger.when.kind === "activity" ? { activity: trigger.when.activity } : {};
		try {
			await conversation.submit(
				{
					type: "input",
					...(request ? { requestId: request } : {}),
					content: [{ type: "text", text: `[trigger] ${label}, ${new Date(now).toString()}\n\n${trigger.prompt}` }],
					entry: {
						kind: TRIGGER_ENTRY,
						data: {
							trigger: id,
							name: trigger.name,
							prompt: trigger.prompt,
							kind: trigger.kind,
							delivery,
							at: now,
							on: trigger.when.kind,
							...activity,
							...judged,
							...(heard ? { device: heard } : {}),
						},
					},
					whenBusy: "followUp",
				},
				context,
			);
		} catch (error) {
			await this.#record(id, { at: now, delivery, outcome: "failed", error: `沒有送出，會再試：${messageOf(error)}` });
			throw error;
		}
		this.#started.set(conversationId, trigger.name);
		await this.#touchBot(conversationId, now);
		await this.#record(id, { at: now, delivery, outcome: "ran", ...confidence }, request);
		return conversationId;
	}

	gaveUp(id: string, reason: string): Promise<void> {
		return this.#record(id, { at: Date.now(), delivery: "later", outcome: "failed", error: `一天內都沒有送出，這次跳過：${reason}` });
	}

	async #markFired(id: string): Promise<void> {
		await this.#harness.commit(async (tx) => {
			const item = (await tx.doc(TriggerDoc)).items.find((candidate) => candidate.id === id);
			if (item) item.state = "fired";
		}, context);
	}

	async #record(id: string, last: LastRun, request?: string): Promise<void> {
		const kept = startOfToday() - RUNS_KEPT_MS;
		await this.#harness.commit(async (tx) => {
			const triggers = await tx.doc(TriggerDoc);
			const item = triggers.items.find((candidate) => candidate.id === id);
			if (!item) return;
			item.last = last;
			if (last.outcome !== "ran") return;
			if (request && triggers.runs.some((run) => run.request === request)) return;
			triggers.runs = [...triggers.runs.filter((run) => run.at >= kept), { trigger: id, at: last.at, ...(request ? { request } : {}) }];
			if (item.when.kind === "once" && last.delivery !== "manual") triggers.items = triggers.items.filter((candidate) => candidate.id !== id);
		}, context);
		await this.sync();
	}

	finished(id: ConversationId): Promise<void> | undefined {
		const schedule = this.#started.get(id);
		if (schedule === undefined) return undefined;
		this.#started.delete(id);
		if (!native.implements(Triggers.report)) return Promise.resolve();
		return orLogged(this.#report(id, schedule), "trigger.report_failed", undefined, { conversation: String(id) });
	}

	async #report(id: ConversationId, schedule: string): Promise<void> {
		const conversation = await this.#harness.conversation(id, context);
		const bot = (await this.#bots()).find((candidate) => candidate.id === id);
		if (!conversation || !bot) return;
		const view = await conversation.viewState(context);
		const answer = view.value.entries.findLast((entry) => entry.kind === "pi.assistant" && entryText(entry).trim() !== "");
		view.dispose();
		const [headline = "跑完了，沒有留下文字", ...detail] = answer ? plain(entryText(answer)).split("\n") : [];
		await Triggers.report({ conversation: String(id), bot: bot.name, avatar: bot.avatar, schedule, headline, text: detail.join("\n"), at: Date.now() });
	}
}

function plain(markdown: string): string {
	return markdown
		.split("\n")
		.map((line) => line.replaceAll("**", "").replaceAll("`", "").trim())
		.map((line) => (line.startsWith("#") ? line.slice(line.indexOf(" ") + 1) : line))
		.filter(Boolean)
		.join("\n");
}
