// Triggers: runs that start without the user typing. A trigger belongs to a bot and has a schedule and a prompt; when
// it fires, the prompt is submitted to the bot's conversation as a `trigger.run` entry. Definitions live in a pi-durable document; the native side
// (TriggersPlugin) keeps a mirror of the schedules so alarms fire, and survive a reboot, without the WebView, and it
// queues what happened until the WebView runs again. See docs/design/triggers.md.
import { Capacitor, registerPlugin } from "@capacitor/core";
import { type ConversationId, defineDoc, defineExtension, section } from "@earendil-works/pi-durable";
import { checkpointEvery64 } from "./doc-policy.ts";
import { type Static, Type } from "typebox";
import { defineAppTool, localTime, parseClock, parseLocalTime, requireNative, text } from "./tools/common.ts";
import { parse } from "./parse.ts";
import { resolvePlace } from "./tools/device.ts";

/** The window of an event schedule: ISO weekdays (empty: every day), from and until (local HH:MM, both optional; may cross midnight), and at most one run every gapHours (24: once per calendar day). */
const EventWindow = {
	days: Type.Array(Type.Integer({ minimum: 1, maximum: 7 })),
	from: Type.Optional(Type.String({ pattern: "^\\d{2}:\\d{2}$" })),
	until: Type.Optional(Type.String({ pattern: "^\\d{2}:\\d{2}$" })),
	gapHours: Type.Integer({ minimum: 1, maximum: 24 }),
};

const When = Type.Union([
	/** Every day, or on the given ISO weekdays (Monday is 1), at a local time. */
	Type.Object({ kind: Type.Literal("daily"), time: Type.String({ pattern: "^\\d{2}:\\d{2}$" }), days: Type.Array(Type.Integer({ minimum: 1, maximum: 7 })) }),
	/** Once, at an epoch time. */
	Type.Object({ kind: Type.Literal("once"), at: Type.Number() }),
	/**
	 * When headphones connect, on the given ISO weekdays (empty: every day), between from and until (local HH:MM, both
	 * optional; may cross midnight), and at most once every gapHours; 24 means once per calendar day.
	 */
	Type.Object({ kind: Type.Literal("headphones"), ...EventWindow }),
	/** When the phone starts charging (TriggerEvents.java). */
	Type.Object({ kind: Type.Literal("charging"), ...EventWindow }),
	/** When a Wi-Fi network connects; with ssid, only that one. */
	Type.Object({ kind: Type.Literal("wifi"), ssid: Type.Optional(Type.String()), ...EventWindow }),
	/** When the phone arrives at or leaves a place: a circle of radius meters. */
	Type.Object({
		kind: Type.Literal("place"),
		on: Type.Union([Type.Literal("arrive"), Type.Literal("leave")]),
		label: Type.String(),
		latitude: Type.Number(),
		longitude: Type.Number(),
		radius: Type.Number({ minimum: 100 }),
		...EventWindow,
	}),
]);
export type When = Static<typeof When>;

/** A schedule, or a follow-up the bot set itself to check something later. */
type TriggerKind = "schedule" | "followup";

/** How a run started: the WebView was running ("live"), pi was opened afterwards ("later"), or from Settings ("manual"). */
export type Delivery = "live" | "later" | "manual";

// Type aliases, not interfaces: documents need JSON-assignable types.
export type Trigger = {
	id: string;
	name: string;
	prompt: string;
	when: When;
	kind: TriggerKind;
	/** The bot's conversation, where its runs go. */
	conversationId: ConversationId;
	enabled: boolean;
	createdAt: number;
	last?: { at: number; delivery: Delivery; error?: string };
};

export const TriggerDoc = defineDoc<{ items: Trigger[]; runs: { trigger: string; at: number }[] }>({
	kind: "app.triggers",
	version: 1,
	scope: "session",
	initial: () => ({ items: [], runs: [] }),
	checkpointWhen: checkpointEvery64,
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
	kind: Type.String(),
	delivery: Type.String(),
	/** When it fired; older entries have none. */
	at: Type.Optional(Type.Number()),
	/** For a headphones schedule, the headphones that connected. */
	device: Type.Optional(Type.String()),
});

const QueuedEvent = Type.Union([
	Type.Object({
		id: Type.String(),
		at: Type.Number(),
		kind: Type.Literal("alarm"),
		trigger: Type.String(),
		live: Type.Boolean(),
		/** For a headphones schedule, the headphones that connected. */
		device: Type.Optional(Type.String()),
	}),
	Type.Object({
		id: Type.String(),
		at: Type.Number(),
		kind: Type.Literal("share"),
		/** Sent by pi as the assistant (AssistSession.java): the screen the user summoned it on. */
		source: Type.Optional(Type.Literal("assist")),
		text: Type.Optional(Type.String()),
		subject: Type.Optional(Type.String()),
		/** Copies in the native inbox, read through Capacitor's file server (Capacitor.convertFileSrc). */
		files: Type.Optional(Type.Array(Type.Object({ path: Type.String(), name: Type.String(), mimeType: Type.String() }))),
	}),
]);
export type QueuedEvent = Static<typeof QueuedEvent>;

interface TriggersPlugin {
	sync(options: { schedules: { id: string; name: string; when: When; avatar?: string }[] }): Promise<{ next: Record<string, number> }>;
	events(): Promise<{ events: unknown[] }>;
	ack(options: { ids: string[] }): Promise<void>;
	started(options: { trigger: string }): Promise<void>;
	status(): Promise<{ exactAlarms: boolean; bluetooth: boolean }>;
	requestBluetooth(): Promise<{ granted: boolean }>;
	requestLocationAlways(): Promise<{ foreground: boolean; background: boolean }>;
	simulateHeadphones(options: { device: string; delayMs?: number }): Promise<void>;
	requestExactAlarms(): Promise<void>;
	notify(options: { title: string; text: string; conversation?: string; avatar?: string }): Promise<void>;
	addListener(event: "event", listener: () => void): Promise<{ remove: () => Promise<void> }>;
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

function describeDays(list: readonly number[]): string {
	const days = [...list].sort();
	if (days.length === 0 || days.length === 7) return "每天";
	if (days.join() === "1,2,3,4,5") return "平日";
	if (days.join() === "6,7") return "週末";
	return `每週${days.map((day) => WEEKDAY_NAMES[day - 1]).join("、")}`;
}

/** When a trigger fires, in words: 每天 08:00, 平日 08:00, 10/31（六）10:00, 平日 07:00–10:00 戴上耳機時（最多每 4 小時一次）. */
export function describeWhen(when: When): string {
	if (when.kind === "once") return clock(when.at);
	if (when.kind === "daily") return `${describeDays(when.days)} ${when.time}`;
	const window = when.from || when.until ? ` ${when.from ?? "00:00"}–${when.until ?? "24:00"}` : "";
	const days = describeDays(when.days);
	const limit = when.gapHours >= 24 ? "一天一次" : `最多每 ${when.gapHours} 小時一次`;
	const event =
		when.kind === "headphones"
			? "戴上耳機時"
			: when.kind === "charging"
				? "開始充電時"
				: when.kind === "wifi"
					? `連上 ${when.ssid ? `Wi‑Fi「${when.ssid}」` : "Wi‑Fi"}時`
					: `${when.on === "arrive" ? "到達" : "離開"}${when.label}時`;
	return `${days === "每天" && window ? "" : days}${window} ${event}（${limit}）`.trim();
}

export function describeTime(at: number): string {
	return clock(at);
}

const hhmm = (value: string, name: string) => parseClock(value, name).text;

function summary(trigger: Trigger): string {
	const kind = trigger.kind === "followup" ? "follow-up" : "schedule";
	// The time in the form the tools take, for the model; describeWhen is the user's words for it.
	const at = trigger.when.kind === "once" ? `, at ${localTime(trigger.when.at)}` : "";
	return `- ${trigger.id}: ${trigger.name} (${describeWhen(trigger.when)}${at}, ${kind}${trigger.enabled ? "" : ", paused"}): ${trigger.prompt}`;
}

/** Location "all the time", which events while pi is not running need; asks, and says what to do when it was not given. */
async function needLocationAlways(what: string): Promise<void> {
	const { background } = await Triggers.requestLocationAlways();
	if (!background) {
		throw new Error(
			`pi needs location "allow all the time" to know ${what} while it is not open, and the user has not allowed it. Tell them: 設定 › 應用程式 › pi mobile › 權限 › 位置資訊 › 一律允許, then ask again.`,
		);
	}
}

export interface TriggerHost {
	/** The definitions changed: mirror them to the native side and refresh the UI. */
	changed(): void;
	/** Post a notification that opens `conversationId`; false when the user is looking at pi, so none was needed. */
	notify(title: string, text: string, conversationId: ConversationId): Promise<boolean>;
}

export function createTriggerExtension(host: TriggerHost) {
	const createSchedule = defineAppTool({
		name: "create_schedule",
		description:
			"Schedule a recurring or one-time run of yourself: at a time (on: time, with time or at), or on an event (on: headphones, charging, wifi, arrive or leave a place), the prompt is sent to you in this conversation as a new turn, even if the user is not using the phone, so you can compare with earlier runs. For a reminder that needs no work, set_alarm is enough.",
		parameters: Type.Object({
			name: Type.String({ description: "Short name shown to the user, such as 早晨簡報" }),
			prompt: Type.String({ description: "What to do when it fires, written as an instruction to yourself" }),
			on: Type.Union(
				[Type.Literal("time"), Type.Literal("headphones"), Type.Literal("charging"), Type.Literal("wifi"), Type.Literal("arrive"), Type.Literal("leave")],
				{
					description:
						"time: at time (recurring) or at (once). Or an event: headphones connect, the phone starts charging, a Wi-Fi connects, the phone arrives at or leaves place; days, from, until apply too",
				},
			),
			time: Type.Optional(Type.String({ description: "Recurring: 24-hour local time HH:MM" })),
			days: Type.Optional(Type.Array(Type.Union(WEEKDAYS.map((day) => Type.Literal(day))), { description: "Recurring: weekdays; omit for every day" })),
			at: Type.Optional(Type.String({ description: "One-time: local date and time YYYY-MM-DD HH:MM; give either time or at" })),
			wifi_name: Type.Optional(Type.String({ description: "With on wifi: only this network (its SSID); omit for any Wi-Fi" })),
			place: Type.Optional(Type.String({ description: "With on arrive or leave: an address or place name, or lat,lon; the user's home or office from memory" })),
			radius_m: Type.Optional(Type.Integer({ minimum: 100, description: "With arrive or leave: how near counts, in meters (default 200)" })),
			from: Type.Optional(Type.String({ description: "With on: only from this local time HH:MM" })),
			until: Type.Optional(Type.String({ description: "With on: only until this local time HH:MM" })),
			at_most_every_hours: Type.Optional(Type.Integer({ minimum: 1, maximum: 24, description: "With on: at most one run per this many hours; default 4; 24 means once per day (the first time that day)" })),
		}),
		execute: async (args, api, context) => {
			requireNative();
			let when: When;
			const days = (args.days ?? []).map((day) => WEEKDAYS.indexOf(day) + 1);
			if (args.on !== "time") {
				const window = {
					days,
					...(args.from ? { from: hhmm(args.from, "from") } : {}),
					...(args.until ? { until: hhmm(args.until, "until") } : {}),
					gapHours: args.at_most_every_hours ?? 4,
				};
				if (args.on === "headphones") {
					when = { kind: "headphones", ...window };
					// The broadcast that says headphones connected needs this permission from Android 12 on.
					const { granted } = await Triggers.requestBluetooth();
					if (!granted) throw new Error("the user did not allow pi to see Bluetooth connections, so it cannot tell when headphones connect; wired headphones still work while pi runs. Ask them to allow 鄰近裝置 for pi if they want it.");
				} else if (args.on === "charging") {
					when = { kind: "charging", ...window };
				} else if (args.on === "wifi") {
					when = { kind: "wifi", ...(args.wifi_name ? { ssid: args.wifi_name } : {}), ...window };
					// Android shows a network's name only to apps with location, in the background "all the time".
					if (args.wifi_name) await needLocationAlways("which Wi-Fi it is");
				} else {
					if (!args.place) throw new Error("arrive and leave need place");
					const point = await resolvePlace(args.place);
					when = { kind: "place", on: args.on, label: args.place, latitude: point.latitude, longitude: point.longitude, radius: args.radius_m ?? 200, ...window };
					await needLocationAlways("where the phone is");
				}
			} else if (args.at && !args.time) {
				const { ms: at, hasTime } = parseLocalTime(args.at, "at");
				if (!hasTime) throw new Error("at needs a time: YYYY-MM-DD HH:MM");
				if (at <= Date.now()) throw new Error(`${args.at} is in the past`);
				when = { kind: "once", at };
			} else if (args.time && !args.at) {
				when = { kind: "daily", time: hhmm(args.time, "time"), days };
			} else {
				throw new Error("give either time (recurring) or at (one-time)");
			}
			const existing = await api.snapshot(TriggerDoc, context);
			if ((existing?.items.length ?? 0) >= MAX_TRIGGERS) throw new Error(`there are already ${MAX_TRIGGERS} schedules; delete one first`);
			const trigger: Trigger = {
				id: crypto.randomUUID().slice(0, 8),
				name: args.name,
				prompt: args.prompt,
				when,
				kind: "schedule",
				conversationId: api.conversationId,
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

	const scheduleFollowup = defineAppTool({
		name: "schedule_followup",
		description:
			"Continue this conversation later by yourself, such as checking whether a deployment finished. After the delay, the note is sent back to you here as a new turn. Use it only when a later check is useful; tell the user you scheduled it.",
		parameters: Type.Object({
			minutes: Type.Integer({ minimum: 1, maximum: 1440, description: "How long from now" }),
			label: Type.String({ description: "Short label the user sees in a notification, in their language, such as 查部署結果" }),
			note: Type.String({ description: "What to check or do then, as an instruction to yourself" }),
		}),
		execute: async (args, api, context) => {
			requireNative();
			const existing = await api.snapshot(TriggerDoc, context);
			const pending = existing?.items.filter((item) => item.kind === "followup").length ?? 0;
			if (pending >= MAX_FOLLOWUPS) throw new Error(`there are already ${MAX_FOLLOWUPS} pending follow-ups`);
			const at = Date.now() + args.minutes * 60_000;
			const trigger: Trigger = {
				id: crypto.randomUUID().slice(0, 8),
				name: args.label,
				prompt: args.note,
				when: { kind: "once", at },
				kind: "followup",
				conversationId: api.conversationId,
				enabled: true,
				createdAt: Date.now(),
			};
			await api.commit(async (tx) => {
				(await tx.doc(TriggerDoc)).items.push(trigger);
			}, context);
			host.changed();
			return text(`Follow-up ${trigger.id} at ${localTime(at)}.`);
		},
	});

	const listSchedules = defineAppTool({
		name: "list_schedules",
		description: "Your schedules and pending follow-ups, with their ids.",
		parameters: Type.Object({}),
		execute: async (_args, api, context) => {
			const items = ((await api.snapshot(TriggerDoc, context))?.items ?? []).filter((item) => item.conversationId === api.conversationId);
			return text(items.length > 0 ? items.map(summary).join("\n") : "No schedules.");
		},
	});

	const deleteSchedule = defineAppTool({
		name: "delete_schedule",
		description: "Delete a schedule or a pending follow-up by id.",
		parameters: Type.Object({ id: Type.String({ description: "The id list_schedules shows" }) }),
		execute: async (args, api, context) => {
			const trigger = (await api.snapshot(TriggerDoc, context))?.items.find(
				(item) => item.id === args.id && item.conversationId === api.conversationId,
			);
			if (!trigger) throw new Error(`no schedule ${args.id}; list_schedules shows them`);
			await api.commit(async (tx) => {
				const doc = await tx.doc(TriggerDoc);
				doc.items = doc.items.filter((item) => item.id !== args.id);
			}, context);
			host.changed();
			return text(`Deleted ${trigger.name}.`);
		},
	});

	const notify = defineAppTool({
		name: "notify",
		description:
			"Show the user a phone notification that opens this conversation. Use it at the end of a triggered run when the result deserves their attention; skip it when there is nothing new. Keep it to the gist; the full answer is in the conversation.",
		parameters: Type.Object({
			title: Type.String({ description: "Short, such as 早晨簡報" }),
			text: Type.String({ description: "One to three short lines" }),
		}),
		execute: async (args, api) => {
			requireNative();
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
					`A message starting "[trigger]" came from a schedule; the user is not watching: do the work, answer briefly without mentioning the schedule, and notify the gist when it is worth it.`,
					"Headphones connected: the user is listening, not reading: read the spoken-report skill and report with speak. Other events (charging, Wi-Fi, a place) say what happened.",
				].join("\n"),
			),
		],
	});
}
