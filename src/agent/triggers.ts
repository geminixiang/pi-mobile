// Triggers: runs that start without the user typing. A trigger has a schedule and a prompt; when it fires, the prompt
// is submitted to a conversation as a `trigger.run` entry. Definitions live in a pi-durable document; the native side
// (TriggersPlugin) keeps a mirror of the schedules so alarms fire, and survive a reboot, without the WebView, and it
// queues what happened until the WebView runs again. See docs/design/triggers.md.
import { Capacitor, registerPlugin } from "@capacitor/core";
import { type ConversationId, defineDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";
import { requestConfirmation } from "./confirm.ts";
import { parse } from "./parse.ts";

const When = Type.Union([
	/** Every day, or on the given ISO weekdays (Monday is 1), at a local time. */
	Type.Object({ kind: Type.Literal("daily"), time: Type.String({ pattern: "^\\d{2}:\\d{2}$" }), days: Type.Array(Type.Integer({ minimum: 1, maximum: 7 })) }),
	/** Once, at an epoch time. */
	Type.Object({ kind: Type.Literal("once"), at: Type.Number() }),
]);
export type When = Static<typeof When>;

/**
 * Where a trigger's runs go: one conversation of its own that keeps every run (so a briefing can compare with
 * yesterday), a new conversation each time, or back to the conversation that scheduled it (a follow-up).
 */
export type TriggerTarget = "thread" | "new" | "origin";

/** How a run started: the WebView was running ("live"), pi was opened afterwards ("later"), or from Settings ("manual"). */
export type Delivery = "live" | "later" | "manual";

// Type aliases, not interfaces: documents need JSON-assignable types.
export type Trigger = {
	id: string;
	name: string;
	prompt: string;
	when: When;
	target: TriggerTarget;
	/** The thread, or for a follow-up the conversation that scheduled it. */
	conversationId?: ConversationId;
	enabled: boolean;
	createdAt: number;
	last?: { at: number; delivery: Delivery; conversationId?: ConversationId; error?: string };
};

export const TriggerDoc = defineDoc<{ items: Trigger[]; runs: { trigger: string; at: number }[] }>({
	kind: "app.triggers",
	version: 1,
	scope: "session",
	initial: () => ({ items: [], runs: [] }),
});

/** Runs a trigger may start per day, and all triggers together, so one that misfires cannot spend without bound. */
export const LIMITS = { perTrigger: 10, total: 30 };
const MAX_TRIGGERS = 20;
const MAX_FOLLOWUPS = 5;

/** Entry kind of a triggered input; the model sees its content as a user message. */
export const TRIGGER_ENTRY = "trigger.run";
export const TriggerEntryData = Type.Object({
	trigger: Type.String(),
	name: Type.String(),
	prompt: Type.String(),
	target: Type.String(),
	delivery: Type.String(),
	/** When it fired; older entries have none. */
	at: Type.Optional(Type.Number()),
});

const QueuedEvent = Type.Union([
	Type.Object({ id: Type.String(), at: Type.Number(), kind: Type.Literal("alarm"), trigger: Type.String(), live: Type.Boolean() }),
	Type.Object({
		id: Type.String(),
		at: Type.Number(),
		kind: Type.Literal("share"),
		text: Type.Optional(Type.String()),
		subject: Type.Optional(Type.String()),
		file: Type.Optional(Type.Object({ path: Type.String(), mimeType: Type.String() })),
	}),
]);
export type QueuedEvent = Static<typeof QueuedEvent>;

interface TriggersPlugin {
	sync(options: { schedules: { id: string; name: string; when: When }[] }): Promise<{ next: Record<string, number> }>;
	events(): Promise<{ events: unknown[] }>;
	ack(options: { ids: string[] }): Promise<void>;
	started(options: { trigger: string }): Promise<void>;
	readFile(options: { path: string }): Promise<{ data: string }>;
	status(): Promise<{ exactAlarms: boolean }>;
	requestExactAlarms(): Promise<void>;
	notify(options: { title: string; text: string; conversation?: string }): Promise<void>;
	askApproval(options: { id: string; title: string; text: string }): Promise<void>;
	cancelApproval(options: { id: string }): Promise<void>;
	addListener(event: "event", listener: () => void): Promise<{ remove: () => Promise<void> }>;
	addListener(event: "approval", listener: (answer: { id: string; approved: boolean }) => void): Promise<{ remove: () => Promise<void> }>;
}

export const Triggers = registerPlugin<TriggersPlugin>("Triggers");
export const nativeTriggers = Capacitor.isNativePlatform();

/** Queued events from the native side; an event that does not parse is dropped with the others' handling. */
export async function takeEvents(): Promise<{ events: QueuedEvent[]; unreadable: string[] }> {
	const { events } = await Triggers.events();
	const parsed: QueuedEvent[] = [];
	const unreadable: string[] = [];
	for (const event of events) {
		try {
			parsed.push(parse(QueuedEvent, event, "觸發事件"));
		} catch {
			const id = typeof event === "object" && event && "id" in event && typeof event.id === "string" ? event.id : undefined;
			if (id) unreadable.push(id);
		}
	}
	return { events: parsed, unreadable };
}

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const WEEKDAY_NAMES = ["一", "二", "三", "四", "五", "六", "日"];

function clock(at: number): string {
	const date = new Date(at);
	return `${date.getMonth() + 1}/${date.getDate()}（${WEEKDAY_NAMES[(date.getDay() + 6) % 7]}）${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** When a trigger fires, in words: 每天 08:00, 平日 08:00, 每週一、三 08:00, 10/31（六）10:00. */
export function describeWhen(when: When): string {
	if (when.kind === "once") return clock(when.at);
	const days = [...when.days].sort();
	if (days.length === 0 || days.length === 7) return `每天 ${when.time}`;
	if (days.join() === "1,2,3,4,5") return `平日 ${when.time}`;
	if (days.join() === "6,7") return `週末 ${when.time}`;
	return `每週${days.map((day) => WEEKDAY_NAMES[day - 1]).join("、")} ${when.time}`;
}

export function describeTime(at: number): string {
	return clock(at);
}

/** "YYYY-MM-DDTHH:MM" in the phone's local time. */
function parseLocal(value: string): number {
	const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(value.trim());
	if (!match) throw new Error(`at must be YYYY-MM-DDTHH:MM local time, got ${value}`);
	const [, year, month, day, hour, minute] = match.map(Number);
	return new Date(year ?? 0, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0).getTime();
}

const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });

function summary(trigger: Trigger): string {
	const target = trigger.target === "origin" ? "follow-up to its conversation" : trigger.target === "new" ? "new conversation each time" : "its own conversation";
	return `- ${trigger.id}: ${trigger.name} (${describeWhen(trigger.when)}, ${target}${trigger.enabled ? "" : ", paused"}): ${trigger.prompt}`;
}

export interface TriggerHost {
	/** The definitions changed: mirror them to the native side and refresh the UI. */
	changed(): void;
	/** Post a notification that opens `conversationId`; false when the user is looking at pi, so none was needed. */
	notify(title: string, text: string, conversationId: ConversationId): Promise<boolean>;
}

export function createTriggerExtension(host: TriggerHost) {
	const createSchedule = defineTool({
		name: "create_schedule",
		description:
			"Schedule a recurring or one-time run of yourself: at the time, the prompt is sent to you as a new turn, even if the user is not using the phone. The user approves it first. For a reminder that needs no work, set_alarm is enough.",
		parameters: Type.Object({
			name: Type.String({ description: "Short name shown to the user, such as 早晨簡報" }),
			prompt: Type.String({ description: "What to do when it fires, written as an instruction to yourself" }),
			time: Type.Optional(Type.String({ description: "Recurring: 24-hour local time HH:MM" })),
			days: Type.Optional(Type.Array(Type.Union(WEEKDAYS.map((day) => Type.Literal(day))), { description: "Recurring: weekdays; omit for every day" })),
			at: Type.Optional(Type.String({ description: "One-time: local date and time YYYY-MM-DDTHH:MM. Give either time or at." })),
			conversation: Type.Optional(
				Type.Union([Type.Literal("thread"), Type.Literal("new")], {
					description: "thread (default): every run in one conversation of its own, so it can compare with earlier runs; new: a fresh conversation each time",
				}),
			),
		}),
		execute: async (args, api, context) => {
			if (!nativeTriggers) throw new Error("only available in the Android app");
			let when: When;
			if (args.at && !args.time) {
				const at = parseLocal(args.at);
				if (at <= Date.now()) throw new Error(`${args.at} is in the past`);
				when = { kind: "once", at };
			} else if (args.time && !args.at) {
				const match = /^(\d{1,2}):(\d{2})$/.exec(args.time.trim());
				if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error(`time must be HH:MM, got ${args.time}`);
				when = { kind: "daily", time: `${match[1]?.padStart(2, "0")}:${match[2]}`, days: (args.days ?? []).map((day) => WEEKDAYS.indexOf(day) + 1) };
			} else {
				throw new Error("give either time (recurring) or at (one-time)");
			}
			const existing = await api.snapshot(TriggerDoc, context);
			if ((existing?.items.length ?? 0) >= MAX_TRIGGERS) throw new Error(`there are already ${MAX_TRIGGERS} schedules; delete one first`);
			const approved = await requestConfirmation({
				title: `新增排程「${args.name}」：${describeWhen(when)}`,
				detail: `到時候 pi 會自動執行：\n${args.prompt}`,
			});
			if (!approved) return { output: [{ type: "text", text: "The user declined; nothing was scheduled. Reply with one short sentence that nothing was done, such as 「好，沒有加。」; do not list what it would have been, offer alternatives, or ask why." }], isError: true };
			const trigger: Trigger = {
				id: crypto.randomUUID().slice(0, 8),
				name: args.name,
				prompt: args.prompt,
				when,
				target: args.conversation ?? "thread",
				enabled: true,
				createdAt: Date.now(),
			};
			await api.commit(async (tx) => {
				(await tx.doc(TriggerDoc)).items.push(trigger);
			}, context);
			host.changed();
			return text(`Scheduled ${trigger.id}: ${trigger.name}, ${describeWhen(when)}. The user can pause or delete it in Settings.`);
		},
	});

	const scheduleFollowup = defineTool({
		name: "schedule_followup",
		description:
			"Continue this conversation later by yourself, such as checking whether a deployment finished. After the delay, the note is sent back to you here as a new turn. Use it only when a later check is useful; tell the user you scheduled it.",
		parameters: Type.Object({
			minutes: Type.Integer({ minimum: 1, maximum: 1440 }),
			label: Type.String({ description: "Short label the user sees in a notification, in their language, such as 查部署結果" }),
			note: Type.String({ description: "What to check or do then, as an instruction to yourself" }),
		}),
		execute: async (args, api, context) => {
			if (!nativeTriggers) throw new Error("only available in the Android app");
			const existing = await api.snapshot(TriggerDoc, context);
			const pending = existing?.items.filter((item) => item.target === "origin").length ?? 0;
			if (pending >= MAX_FOLLOWUPS) throw new Error(`there are already ${MAX_FOLLOWUPS} pending follow-ups`);
			const at = Date.now() + args.minutes * 60_000;
			const trigger: Trigger = {
				id: crypto.randomUUID().slice(0, 8),
				name: args.label,
				prompt: args.note,
				when: { kind: "once", at },
				target: "origin",
				conversationId: api.conversationId,
				enabled: true,
				createdAt: Date.now(),
			};
			await api.commit(async (tx) => {
				(await tx.doc(TriggerDoc)).items.push(trigger);
			}, context);
			host.changed();
			return text(`Follow-up ${trigger.id} at ${clock(at)}.`);
		},
	});

	const listSchedules = defineTool({
		name: "list_schedules",
		description: "The schedules and pending follow-ups, with their ids.",
		parameters: Type.Object({}),
		execute: async (_args, api, context) => {
			const items = (await api.snapshot(TriggerDoc, context))?.items ?? [];
			return text(items.length > 0 ? items.map(summary).join("\n") : "No schedules.");
		},
	});

	const deleteSchedule = defineTool({
		name: "delete_schedule",
		description: "Delete a schedule or a pending follow-up by id. The user approves deleting a schedule.",
		parameters: Type.Object({ id: Type.String() }),
		execute: async (args, api, context) => {
			const trigger = (await api.snapshot(TriggerDoc, context))?.items.find((item) => item.id === args.id);
			if (!trigger) throw new Error(`no schedule ${args.id}; list_schedules shows them`);
			if (trigger.target !== "origin") {
				const approved = await requestConfirmation({ title: `刪除排程「${trigger.name}」`, detail: `${describeWhen(trigger.when)}\n${trigger.prompt}` });
				if (!approved) return { output: [{ type: "text", text: "The user declined; the schedule stays. Reply with one short sentence that nothing was done, such as 「好，不刪。」; do not list what it would have been, offer alternatives, or ask why." }], isError: true };
			}
			await api.commit(async (tx) => {
				const doc = await tx.doc(TriggerDoc);
				doc.items = doc.items.filter((item) => item.id !== args.id);
			}, context);
			host.changed();
			return text(`Deleted ${trigger.name}.`);
		},
	});

	const notify = defineTool({
		name: "notify",
		description:
			"Show the user a phone notification that opens this conversation. Use it at the end of a triggered run when the result deserves their attention; skip it when there is nothing new. Keep it to the gist; the full answer is in the conversation.",
		parameters: Type.Object({
			title: Type.String({ description: "Short, such as 早晨簡報" }),
			text: Type.String({ description: "One to three short lines" }),
		}),
		execute: async (args, api) => {
			if (!nativeTriggers) throw new Error("only available in the Android app");
			const shown = await host.notify(args.title, args.text, api.conversationId);
			// Whether it was shown is not the user's concern; either way they learn the result.
			return text(shown ? "Notified." : "Delivered: the user has pi open and reads your answer.");
		},
	});

	return defineExtension({
		name: "triggers",
		tools: [createSchedule, scheduleFollowup, listSchedules, deleteSchedule, notify],
		sections: [
			section("triggers", () =>
				[
					"create_schedule: recurring or one-time work the user asks for. schedule_followup: check again in this conversation later.",
					`A message starting "[trigger]" came from a schedule and the user is not watching: do the work, answer briefly without mentioning schedules or notifications, and notify the gist only when it is worth it. Approvals go to a notification and are declined after 30 minutes.`,
				].join("\n"),
			),
		],
	});
}
