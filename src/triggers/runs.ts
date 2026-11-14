import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Value } from "typebox/value";
import { type Conversation, type ConversationId, defineDoc, type EntryRecord, type Harness } from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";
import { native } from "../native.ts";
import { checkpointEvery64 } from "../agent/doc-policy.ts";
import { DAY, MINUTE, startOfToday } from "../time.ts";
import { isWatch } from "./watch.ts";
import { check, oneOf, valueOrThrow } from "../parse.ts";
import { messageOf, orLogged } from "../promise.ts";
import { blocks, entryText, message } from "../agent/entries.ts";
import { ASK_USER, AskArgs } from "../interaction/tool.ts";
import { answerOf } from "../interaction/replies.ts";
import type { Judge } from "../agent/judge.ts";
import { DEFAULT_GUARDS, GUARD_IDS, type GuardId, screen, screeningQuestions } from "../agent/guards.ts";
import { log } from "../log.ts";
import { Triggers, When } from "./plugin.ts";
import { isEvent } from "./when.ts";
import { agenda, type Item, ITEM_TRIGGER, ItemDoc, itemTrigger, REPLY_TRIGGER, replyTrigger, schedulesOf } from "../items/items.ts";
import type { Status } from "../computer-agents/workers.ts";

const DELIVERIES = ["live", "later", "manual"] as const;
type Delivery = (typeof DELIVERIES)[number];

type Confidence = { kind: "judged"; probability: number } | { kind: "unjudged"; reason: string };

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
	conversationId: ConversationId;
	state: "on" | "paused" | "fired";
	createdAt: number;
	last?: LastRun;
} & ({ kind: "schedule" | "followup" } | { kind: "watch"; agent: string });

export type AgentState = Status | "gone" | "unreachable";

const UNATTENDED = "(Unattended: nobody will answer a question. Start the answer with one line of at most 20 characters that tells the point (what changed or needs the user, or that nothing did), then the details; where something is unclear, pick the likely choice and say the assumption; when a step needs the user, skip it and say what is needed.)";
const WATCH_LIMIT = 12 * 60 * MINUTE;
const DUE_PROMPT =
	"Handle it: do what you can, and notify the user when it needs them. Close it with note_item state done only when the matter itself is settled, not because you reminded the user; otherwise leave it open, with a new next_at if it should come back.";
const REPLY_PROMPT =
	"See whether this notification is what the item waits on. If it is, tell the user the gist with notify, then update the item with note_item: state done when it settles the matter, todo when the user now has to act (reply, decide, pay), waiting only while it still waits on someone else. If it is not, leave the item as it is and answer only that it was unrelated.";

const STILL_WAITING: ReadonlySet<AgentState> = new Set(["working", "unknown", "unreachable"]);

function nextCheck(waited: number): number {
	if (waited < 5 * MINUTE) return MINUTE;
	if (waited < 30 * MINUTE) return 3 * MINUTE;
	return 10 * MINUTE;
}

function watched(agent: string, state: AgentState, waited: number): string {
	if (state === "idle") return `agent ${agent} is idle again`;
	if (state === "needs_user") return `agent ${agent} is waiting for the user to approve or answer`;
	if (state === "gone") return `agent ${agent} is gone (closed, or its terminal was)`;
	return `agent ${agent} is still ${state === "unreachable" ? "unreachable" : "not done"} after ${Math.round(waited / MINUTE)} minutes, so the watch stops`;
}

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
const V1Doc = Type.Object({ items: Type.Array(Type.Unknown()), runs: Type.Array(Type.Object({ trigger: Type.String(), at: Type.Number(), request: Type.Optional(Type.String()) })) });

export const TriggerDoc = defineDoc<{ items: Trigger[]; runs: { trigger: string; at: number; request?: string }[] }>({
	kind: "app.triggers",
	version: 2,
	scope: "session",
	initial: () => ({ items: [], runs: [] }),
	migrate: (value) => {
		const v1 = valueOrThrow(check(V1Doc, value, "第 1 版的排程"));
		const items = v1.items.flatMap((item) => {
			const read = check(V1Trigger, item, "第 1 版的排程");
			if (read.ok) return [fromV1(read.value)];
			log.warn("trigger.unreadable", { problem: read.problem });
			return [];
		});
		return { items, runs: v1.runs };
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

type Outcome =
	| { kind: "ran"; confidence: Confidence | undefined }
	| { kind: "skipped"; reason: string; confidence: Confidence | undefined }
	| { kind: "gone" }
	| { kind: "failed"; error: string };

type Wakeup = {
	key: string;
	conversationId: ConversationId;
	delivery: Delivery;
	request: string | undefined;
	screening: { guards: readonly GuardId[]; onlyIf: string | undefined; automation: string; purpose: string; event: string } | undefined;
	label: (judgement: string) => string;
	prompt: string;
	entry: Omit<TriggerRun, "at" | "judged">;
	started: string;
	settle: (outcome: Outcome, at: number) => Promise<void>;
};

const confidenceOf = (confidence: Confidence | undefined): { confidence?: Confidence } => (confidence ? { confidence } : {});

export const TRIGGER_NOTICE = "trigger.notice";
const TriggerNoticeData = Type.Object({ text: Type.String() });

export function triggerNotice(entry: { kind: string; data?: unknown }): string | undefined {
	return entry.kind === TRIGGER_NOTICE && Value.Check(TriggerNoticeData, entry.data) ? entry.data.text : undefined;
}

export function triggerRun(entry: { kind: string; data?: unknown }): TriggerRun | undefined {
	return entry.kind === TRIGGER_ENTRY && Value.Check(TriggerEntryData, entry.data) ? entry.data : undefined;
}

export interface TriggerState {
	items: Trigger[];
	next: Record<string, number>;
	open: readonly Item[];
}

export const NO_TRIGGERS: TriggerState = { items: [], next: {}, open: [] };

const RUNS_KEPT_MS = DAY;

const context = BACKGROUND_CONTEXT;

export class TriggerRuns {
	readonly #harness: Harness;
	readonly #bots: () => Promise<readonly { id: ConversationId; name: string; avatar: string }[]>;
	readonly #touchBot: (id: ConversationId, at: number) => Promise<void>;
	readonly #judge: Judge;
	readonly #agentState: (conversationId: ConversationId, agent: string) => Promise<AgentState>;
	readonly #listeners = new Set<(state: TriggerState) => void>();
	#state: TriggerState = NO_TRIGGERS;
	readonly #started = new Map<ConversationId, string>();

	constructor(
		harness: Harness,
		bots: () => Promise<readonly { id: ConversationId; name: string; avatar: string }[]>,
		touchBot: (id: ConversationId, at: number) => Promise<void>,
		judge: Judge,
		agentState: (conversationId: ConversationId, agent: string) => Promise<AgentState>,
	) {
		this.#harness = harness;
		this.#bots = bots;
		this.#touchBot = touchBot;
		this.#judge = judge;
		this.#agentState = agentState;
	}

	async removeBot(conversationId: ConversationId): Promise<void> {
		await this.#harness.commit(async (tx) => {
			const doc = await tx.doc(ItemDoc);
			doc.items = doc.items.filter((item) => item.bot !== conversationId);
		}, context);
		await this.#edit((items) => items.filter((item) => item.conversationId !== conversationId));
	}

	subscribe(listener: (state: TriggerState) => void): () => void {
		this.#listeners.add(listener);
		listener(this.#state);
		return () => this.#listeners.delete(listener);
	}

	async sync(): Promise<void> {
		const [triggers, bots, itemDoc] = await Promise.all([this.#harness.snapshot(TriggerDoc, context), this.#bots(), this.#harness.snapshot(ItemDoc, context)]);
		const items = triggers?.items ?? [];
		const avatars = new Map(bots.map((bot) => [bot.id, bot.avatar]));
		const now = Date.now();
		const schedules = [
			...items.filter((item) => item.state === "on").map(({ id, name, when, conversationId }) => ({ id, name, when, conversation: String(conversationId), avatar: avatars.get(conversationId) })),
			...(itemDoc?.items ?? []).flatMap((item) => schedulesOf(item, avatars.get(item.bot), now).map((schedule) => ({ ...schedule, conversation: String(item.bot) }))),
		];
		const [next] = await Promise.all([
			native.implements(Triggers.sync) ? Triggers.sync({ schedules }).then((synced) => synced.next) : {},
			native.implements(Triggers.agenda) ? Triggers.agenda({ items: agenda(itemDoc?.items ?? [], bots, startOfToday() + DAY), bots: bots.map((bot) => String(bot.id)) }) : undefined,
		]);
		this.#state = { items: [...items], next, open: (itemDoc?.items ?? []).filter((item) => item.state !== "done") };
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

	async checkWatch(conversationId: ConversationId, agent: string): Promise<void> {
		const watching = (await this.#harness.snapshot(TriggerDoc, context))?.items.find((item) => isWatch(item, agent, conversationId));
		if (watching) await this.run(watching.id, "live");
	}

	async watching(): Promise<readonly { conversationId: ConversationId; agent: string }[]> {
		return ((await this.#harness.snapshot(TriggerDoc, context))?.items ?? []).flatMap((item) => (item.kind === "watch" ? [{ conversationId: item.conversationId, agent: item.agent }] : []));
	}

	stopWatching(conversationId: ConversationId, agent: string): Promise<void> {
		return this.#edit((items) => items.filter((item) => !isWatch(item, agent, conversationId)));
	}

	delete(id: string): Promise<void> {
		return this.#edit((items) => items.filter((item) => item.id !== id));
	}

	async run(id: string, delivery: Delivery, delivered: { device?: string; event?: string } = {}): Promise<ConversationId | undefined> {
		if (id.startsWith(ITEM_TRIGGER)) return this.#runItem(id.slice(ITEM_TRIGGER.length), delivery, delivered.event, { kind: "due" });
		if (id.startsWith(REPLY_TRIGGER)) return this.#runItem(id.slice(REPLY_TRIGGER.length), delivery, delivered.event, { kind: "reply", heard: delivered.device ?? "a notification" });
		const request = delivered.event ? `trigger:${delivered.event}` : undefined;
		const doc = await this.#harness.snapshot(TriggerDoc, context);
		const trigger = doc?.items.find((item) => item.id === id);
		if (!trigger) return undefined;
		if (!(request && doc?.runs.some((run) => run.request === request)) && delivery !== "manual" && trigger.state === "paused") return undefined;
		const agent = trigger.kind === "watch" ? await this.#agentState(trigger.conversationId, trigger.agent) : undefined;
		const checkedAt = Date.now();
		const waited = checkedAt - trigger.createdAt;
		if (agent && STILL_WAITING.has(agent) && waited < WATCH_LIMIT && delivery !== "manual") {
			await this.#edit((items) => items.map((item) => (item.id !== id ? item : { ...item, state: "on", when: { kind: "once", at: checkedAt + nextCheck(waited) } })));
			return undefined;
		}
		if (trigger.when.kind === "once" && delivery !== "manual" && trigger.state === "on") await this.#markFired(id);
		const heard = isEvent(trigger.when) && delivery !== "manual" ? (delivered.device ?? trigger.when.kind) : undefined;
		const guards = trigger.guards ?? [];
		const activity: Record<string, string> = trigger.when.kind === "activity" ? { activity: trigger.when.activity } : {};
		return this.#deliver({
			key: id,
			conversationId: trigger.conversationId,
			delivery,
			request,
			screening: heard && (guards.length > 0 || trigger.onlyIf) ? { guards, onlyIf: trigger.onlyIf, automation: trigger.name, purpose: trigger.prompt, event: heard } : undefined,
			label: (judgement) => {
				const scheduled = heard ? `schedule "${trigger.name}": ${trigger.when.kind === "headphones" ? `headphones connected (${heard})` : heard}${judgement}` : `schedule "${trigger.name}"`;
				return trigger.kind === "watch" ? watched(trigger.agent, agent ?? "unknown", waited) : trigger.kind === "followup" ? "follow-up you scheduled" : scheduled;
			},
			prompt: trigger.prompt,
			entry: { trigger: id, name: trigger.name, prompt: trigger.prompt, kind: trigger.kind, delivery, on: trigger.when.kind, ...activity, ...(heard ? { device: heard } : {}) },
			started: trigger.name,
			settle: (outcome, at) => {
				if (outcome.kind === "ran") return this.#record(id, { at, delivery, outcome: "ran", ...confidenceOf(outcome.confidence) });
				if (outcome.kind === "skipped") return this.#record(id, { at, delivery, outcome: "skipped", reason: outcome.reason, ...confidenceOf(outcome.confidence) });
				const error = outcome.kind === "gone" ? "它的 Bot 已經刪除" : `沒有送出，會再試：${outcome.error}`;
				return this.#record(id, { at, delivery, outcome: "failed", error });
			},
		});
	}

	async #runItem(id: string, delivery: Delivery, event: string | undefined, cause: { kind: "due" } | { kind: "reply"; heard: string }): Promise<ConversationId | undefined> {
		const request = event ? `trigger:${event}` : undefined;
		const item = (await this.#harness.snapshot(ItemDoc, context))?.items.find((candidate) => candidate.id === id);
		const now = Date.now();
		const due = cause.kind === "reply" ? item?.state === "waiting" && item.wake !== undefined : item !== undefined && item.state !== "done" && item.nextAt !== undefined && item.nextAt <= now + MINUTE;
		const duplicate = request !== undefined && ((await this.#harness.snapshot(TriggerDoc, context))?.runs ?? []).some((run) => run.request === request);
		if (!item || (!due && !duplicate)) {
			await this.sync();
			return undefined;
		}
		const waiting = item.state === "waiting" ? `waiting on ${item.waitingOn}` : item.state;
		const details = [waiting, item.ref ? `details in ${item.ref}` : ""].filter(Boolean).join(", ");
		const notice = (text: string) => this.#notice(item.bot, text);
		return this.#deliver({
			key: cause.kind === "due" ? itemTrigger(id) : replyTrigger(id),
			conversationId: item.bot,
			delivery,
			request,
			screening: cause.kind === "reply" ? { guards: DEFAULT_GUARDS, onlyIf: undefined, automation: item.title, purpose: waiting, event: cause.heard } : undefined,
			label: (judgement) =>
				cause.kind === "reply" ? `item ${item.id} "${item.title}" (${details}): a notification came, ${cause.heard}${judgement}` : `item ${item.id} "${item.title}" (${details}) is due`,
			prompt: cause.kind === "reply" ? REPLY_PROMPT : DUE_PROMPT,
			entry: { trigger: cause.kind === "due" ? itemTrigger(id) : replyTrigger(id), name: item.title, prompt: item.title, kind: "item", delivery, on: cause.kind === "reply" ? "notification" : "once", ...(cause.kind === "reply" ? { device: cause.heard } : {}) },
			started: item.title,
			settle: async (outcome) => {
				if (outcome.kind === "ran") {
					if (cause.kind === "due") await this.#editItems((items) => items.map((candidate) => (candidate.id === id ? withoutNextAt(candidate) : candidate)));
					return;
				}
				if (outcome.kind === "skipped") return notice(`「${item.title}」等的回覆來了，但沒有交給 Bot：${outcome.reason}`);
				if (outcome.kind === "gone") log.info("item.bot_gone", { item: id });
			},
		});
	}

	async #deliver(wakeup: Wakeup): Promise<ConversationId | undefined> {
		const runs = (await this.#harness.snapshot(TriggerDoc, context))?.runs ?? [];
		if (wakeup.request && runs.some((run) => run.request === wakeup.request)) {
			await this.sync();
			return wakeup.conversationId;
		}
		const now = Date.now();
		const conversation = (await this.#bots()).some((bot) => bot.id === wakeup.conversationId) ? await this.#harness.conversation(wakeup.conversationId, context) : undefined;
		if (!conversation) {
			await wakeup.settle({ kind: "gone" }, now);
			await this.sync();
			return undefined;
		}
		const { screening: asked } = wakeup;
		const screening = asked ? screen(asked.guards, asked.onlyIf, await this.#judge.ask(screeningQuestions(asked.guards, asked.onlyIf), { automation: asked.automation, purpose: asked.purpose, event: asked.event })) : undefined;
		const probability = screening?.pass ? screening.judged : screening?.probability;
		const confidence: Confidence | undefined =
			probability !== undefined ? { kind: "judged", probability } : screening?.unjudged ? { kind: "unjudged", reason: screening.unjudged } : undefined;
		if (screening && !screening.pass) {
			await wakeup.settle({ kind: "skipped", reason: screening.reason, confidence }, now);
			if (native.implements(Triggers.skipped)) await Triggers.skipped({ trigger: wakeup.key });
			return undefined;
		}
		const judged = screening?.judged !== undefined ? { judged: screening.judged } : {};
		try {
			await wake(conversation, wakeup.request, `${wakeup.label(screening ? `, ${screening.note}` : "")}, ${new Date(now).toString()}`, wakeup.prompt, { ...wakeup.entry, at: now, ...judged });
		} catch (error) {
			await wakeup.settle({ kind: "failed", error: messageOf(error) }, now);
			throw error;
		}
		this.#started.set(wakeup.conversationId, wakeup.started);
		await this.#touchBot(wakeup.conversationId, now);
		await this.#ran(wakeup.key, now, wakeup.request);
		await wakeup.settle({ kind: "ran", confidence }, now);
		await this.sync();
		return wakeup.conversationId;
	}

	async #ran(key: string, at: number, request: string | undefined): Promise<void> {
		const kept = startOfToday() - RUNS_KEPT_MS;
		await this.#harness.commit(async (tx) => {
			const triggers = await tx.doc(TriggerDoc);
			if (request && triggers.runs.some((run) => run.request === request)) return;
			triggers.runs = [...triggers.runs.filter((run) => run.at >= kept), { trigger: key, at, ...(request ? { request } : {}) }];
		}, context);
	}

	async item(id: string): Promise<Item | undefined> {
		return (await this.#harness.snapshot(ItemDoc, context))?.items.find((item) => item.id === id);
	}

	async finishItem(id: string): Promise<void> {
		const now = Date.now();
		await this.#editItems((items) => items.map((item) => (item.id === id && item.state !== "done" ? { ...item, state: "done", doneAt: now, updatedAt: now } : item)));
		await this.sync();
	}

	async postponeItem(id: string, until: number): Promise<void> {
		const now = Date.now();
		await this.#editItems((items) => items.map((item) => (item.id === id && item.state !== "done" ? { ...item, nextAt: until, updatedAt: now } : item)));
		await this.sync();
	}

	async #editItems(edit: (items: Item[]) => Item[]): Promise<void> {
		await this.#harness.commit(async (tx) => {
			const items = await tx.doc(ItemDoc);
			items.items = edit(items.items);
		}, context);
	}

	async gaveUp(id: string, reason: string): Promise<void> {
		await this.#record(id, { at: Date.now(), delivery: "later", outcome: "failed", error: `一天內都沒有送出，這次跳過：${reason}` });
		await this.sync();
	}

	async missed(id: string, count: number): Promise<void> {
		const trigger = (await this.#harness.snapshot(TriggerDoc, context))?.items.find((item) => item.id === id);
		if (trigger) await this.#notice(trigger.conversationId, `「${trigger.name}」錯過了 ${count} 次，只跑最新一次`);
	}

	#notice(conversationId: ConversationId, text: string): Promise<void> {
		return this.#harness.commit(async (tx) => {
			await tx.appendEntry(conversationId, { kind: TRIGGER_NOTICE, data: { text } });
		}, context);
	}

	async #markFired(id: string): Promise<void> {
		await this.#harness.commit(async (tx) => {
			const item = (await tx.doc(TriggerDoc)).items.find((candidate) => candidate.id === id);
			if (item) item.state = "fired";
		}, context);
	}

	async #record(id: string, last: LastRun): Promise<void> {
		await this.#harness.commit(async (tx) => {
			const triggers = await tx.doc(TriggerDoc);
			const item = triggers.items.find((candidate) => candidate.id === id);
			if (!item) return;
			item.last = last;
			if (last.outcome === "ran" && item.when.kind === "once" && last.delivery !== "manual") triggers.items = triggers.items.filter((candidate) => candidate.id !== id);
		}, context);
	}

	unattended(id: ConversationId): boolean {
		return this.#started.has(id);
	}

	finished(id: ConversationId): Promise<void> | undefined {
		const schedule = this.#started.get(id);
		if (schedule === undefined) return undefined;
		this.#started.delete(id);
		if (!native.implements(Triggers.report)) return Promise.resolve();
		return orLogged(this.#report(id, schedule), "trigger.report_failed", undefined, { conversation: String(id) });
	}

	async lastWord(id: ConversationId): Promise<FinalWord | undefined> {
		const conversation = await this.#harness.conversation(id, context);
		if (!conversation) return undefined;
		const word = finalWord((await conversation.context(context)).entries);
		return { ...word, text: word.text.split("\n").slice(0, DETAIL_LINES).join("\n") };
	}

	async #report(id: ConversationId, schedule: string): Promise<void> {
		const conversation = await this.#harness.conversation(id, context);
		const bot = (await this.#bots()).find((candidate) => candidate.id === id);
		if (!conversation || !bot) return;
		const { entries } = await conversation.context(context);
		const { headline, text } = finalWord(entries);
		await Triggers.report({ conversation: String(id), bot: bot.name, avatar: bot.avatar, schedule, headline, text, at: Date.now() });
	}
}

function wake(conversation: Conversation, request: string | undefined, label: string, prompt: string, data: TriggerRun): Promise<unknown> {
	return conversation.submit(
		{
			type: "input",
			...(request ? { requestId: request } : {}),
			content: [{ type: "text", text: `[trigger] ${label}\n\n${prompt}\n\n${UNATTENDED}` }],
			entry: { kind: TRIGGER_ENTRY, data },
			whenBusy: "followUp",
		},
		context,
	);
}

function withoutNextAt({ nextAt: _passed, ...item }: Item): Item {
	return item;
}

const LINK = /\[([^\]]*)\]\([^)]*\)/g;
const DETAIL_LINES = 3;

type FinalWord = { headline: string; text: string; asking: boolean };

export function finalWord(entries: readonly EntryRecord[]): FinalWord {
	const last = entries.findLast((entry) => entry.kind === "pi.assistant");
	const asked = blocks(last && message(last)?.content).find((block) => block.type === "toolCall" && block.name === ASK_USER);
	const question = asked?.type === "toolCall" ? check(AskArgs, asked.arguments, ASK_USER) : undefined;
	if (question?.ok) return { headline: question.value.question, text: question.value.options.join("、"), asking: true };
	const answer = entries.findLast((entry) => entry.kind === "pi.assistant" && entryText(entry).trim() !== "");
	const [headline = "跑完了，沒有留下文字", ...detail] = answer ? plain(answerOf(answer).text).split("\n") : [];
	return { headline, text: detail.join("\n"), asking: false };
}

function plain(markdown: string): string {
	return markdown
		.split("\n")
		.map((line) => line.replaceAll(LINK, "$1").replaceAll("**", "").replaceAll("`", "").trim())
		.map((line) => (line.startsWith("#") ? line.slice(line.indexOf(" ") + 1) : line))
		.filter(Boolean)
		.join("\n");
}
