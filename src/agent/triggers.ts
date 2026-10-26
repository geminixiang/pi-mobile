import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Value } from "typebox/value";
import { registerPlugin } from "@capacitor/core";
import { native } from "../native.ts";
import { type ConversationId, defineDoc, defineExtension, type Harness, section } from "@earendil-works/pi-durable";
import { checkpointEvery64 } from "./doc-policy.ts";
import { type Static, Type } from "typebox";
import { defineAppTool, localTime, monthDayTime, oneOf, parseClock, parseLocalTime, startOfToday, text } from "./tools/common.ts";
import { resolvePlace } from "./tools/device.ts";
import { Notifications, requireAccess } from "../notifications-plugin.ts";
import { messageOf, serially } from "../promise.ts";
import type { Judge } from "./judge.ts";
import { DEFAULT_GUARDS, GUARD_IDS, type GuardId, screen, screeningQuestions } from "./guards.ts";

const Clock = Type.String({ pattern: "^\\d{2}:\\d{2}$" });
const Days = Type.Array(Type.Integer({ minimum: 1, maximum: 7 }));

const EventWindow = {
	days: Days,
	from: Type.Optional(Clock),
	until: Type.Optional(Clock),
	gapHours: Type.Integer({ minimum: 1, maximum: 24 }),
};

const ACTIVITIES = ["walking", "running", "cycling", "vehicle", "still"] as const;
const Activity = oneOf(ACTIVITIES);
const ACTIVITY_NAMES: Record<(typeof ACTIVITIES)[number], [string, string]> = {
	walking: ["開始走路", "停止走路"],
	running: ["開始跑步", "停止跑步"],
	cycling: ["開始騎車", "停止騎車"],
	vehicle: ["上車", "下車"],
	still: ["靜止下來", "開始移動"],
};

const When = Type.Union([
	Type.Object({ kind: Type.Literal("daily"), time: Clock, days: Days }),
	Type.Object({ kind: Type.Literal("once"), at: Type.Number() }),
	Type.Object({ kind: Type.Literal("headphones"), ...EventWindow }),
	Type.Object({ kind: Type.Literal("charging"), ...EventWindow }),
	Type.Object({ kind: Type.Literal("wifi"), ssid: Type.Optional(Type.String()), ...EventWindow }),
	Type.Object({ kind: Type.Literal("notification"), app: Type.Optional(Type.String()), contains: Type.Optional(Type.String()), ...EventWindow }),
	Type.Object({ kind: Type.Literal("unlock"), ...EventWindow }),
	Type.Object({ kind: Type.Literal("battery_low"), ...EventWindow }),
	Type.Object({ kind: Type.Literal("timezone"), ...EventWindow }),
	Type.Object({ kind: Type.Literal("photo"), album: Type.Optional(Type.String()), ...EventWindow }),
	Type.Object({ kind: Type.Literal("bluetooth"), on: Type.Union([Type.Literal("connect"), Type.Literal("disconnect")]), device: Type.String(), ...EventWindow }),
	Type.Object({ kind: Type.Literal("activity"), on: Type.Union([Type.Literal("start"), Type.Literal("stop")]), activity: Activity, ...EventWindow }),
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

type TriggerKind = "schedule" | "followup";

type Delivery = "live" | "later" | "manual";

export type Trigger = {
	id: string;
	name: string;
	prompt: string;
	when: When;
	onlyIf?: string;
	guards?: GuardId[];
	kind: TriggerKind;
	conversationId: ConversationId;
	enabled: boolean;
	createdAt: number;
	last?: { at: number; delivery: Delivery; error?: string; judged?: number; skipped?: { reason: string; probability?: number }; unjudged?: string };
	fired?: boolean;
};

export const TriggerDoc = defineDoc<{ items: Trigger[]; runs: { trigger: string; at: number; request?: string }[] }>({
	kind: "app.triggers",
	version: 1,
	scope: "session",
	initial: () => ({ items: [], runs: [] }),
	checkpointWhen: checkpointEvery64,
});

export const LIMITS = { perTrigger: 10, total: 30 };
const MAX_TRIGGERS = 20;
const MAX_FOLLOWUPS = 5;

export const TRIGGER_ENTRY = "trigger.run";
export const TriggerEntryData = Type.Object({
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

const QueuedEvent = Type.Union([
	Type.Object({
		id: Type.String(),
		at: Type.Number(),
		kind: Type.Literal("alarm"),
		trigger: Type.String(),
		live: Type.Boolean(),
		device: Type.Optional(Type.String()),
	}),
	Type.Object({
		id: Type.String(),
		at: Type.Number(),
		kind: Type.Literal("share"),
		source: Type.Optional(Type.Literal("assist")),
		text: Type.Optional(Type.String()),
		subject: Type.Optional(Type.String()),
		files: Type.Optional(Type.Array(Type.Object({ path: Type.String(), name: Type.String(), mimeType: Type.String() }))),
	}),
]);
export type QueuedEvent = Static<typeof QueuedEvent>;

interface TriggersPlugin {
	sync(options: { schedules: { id: string; name: string; when: When; avatar?: string }[] }): Promise<{ next: Record<string, number> }>;
	events(): Promise<{ events: unknown[] }>;
	ack(options: { ids: string[] }): Promise<void>;
	started(options: { trigger: string }): Promise<void>;
	skipped(options: { trigger: string }): Promise<void>;
	status(): Promise<{ exactAlarms: boolean; bluetooth: boolean }>;
	requestBluetooth(): Promise<{ granted: boolean }>;
	requestAccess(options: { to: "photos" | "activity" }): Promise<{ granted: boolean }>;
	requestLocationAlways(): Promise<{ foreground: boolean; background: boolean }>;
	requestExactAlarms(): Promise<void>;
	notify(options: { title: string; text: string; conversation?: string; avatar?: string }): Promise<void>;
	addListener(event: "event", listener: () => void): Promise<{ remove: () => Promise<void> }>;
}

export const Triggers = registerPlugin<TriggersPlugin>("Triggers");
export const nativeTriggers = native.has("Triggers");

export async function takeEvents(): Promise<{ events: QueuedEvent[]; unreadable: string[] }> {
	const { events } = await Triggers.events();
	const parsed: QueuedEvent[] = [];
	const unreadable: string[] = [];
	for (const event of events) {
		if (Value.Check(QueuedEvent, event)) {
			parsed.push(event);
			continue;
		}
		const id = typeof event === "object" && event && "id" in event && typeof event.id === "string" ? event.id : undefined;
		if (id) unreadable.push(id);
	}
	return { events: parsed, unreadable };
}

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const WEEKDAY_NAMES = ["一", "二", "三", "四", "五", "六", "日"];

export function describeTime(at: number): string {
	const [day, clock] = monthDayTime(at).split(" ");
	return `${day}（${WEEKDAY_NAMES[(new Date(at).getDay() + 6) % 7]}）${clock}`;
}

function describeDays(list: readonly number[]): string {
	const days = [...list].sort();
	if (days.length === 0 || days.length === 7) return "每天";
	if (days.join() === "1,2,3,4,5") return "平日";
	if (days.join() === "6,7") return "週末";
	return `每週${days.map((day) => WEEKDAY_NAMES[day - 1]).join("、")}`;
}

export function describeWhen(when: When): string {
	if (when.kind === "once") return describeTime(when.at);
	if (when.kind === "daily") return `${describeDays(when.days)} ${when.time}`;
	const window = when.from || when.until ? ` ${when.from ?? "00:00"}–${when.until ?? "24:00"}` : "";
	const days = describeDays(when.days);
	const limit = when.gapHours >= 24 ? "一天一次" : `最多每 ${when.gapHours} 小時一次`;
	return `${days === "每天" ? "" : days}${window} ${describeEvent(when)}（${limit}）`.trim();
}

function describeEvent(when: Exclude<When, { kind: "once" | "daily" }>): string {
	switch (when.kind) {
		case "headphones":
			return "戴上耳機時";
		case "charging":
			return "開始充電時";
		case "wifi":
			return `連上 ${when.ssid ? `Wi‑Fi「${when.ssid}」` : "Wi‑Fi"}時`;
		case "notification":
			return `收到${when.app ? ` ${when.app} ` : ""}${when.contains ? `含「${when.contains}」的` : ""}通知時`;
		case "place":
			return `${when.on === "arrive" ? "到達" : "離開"}${when.label}時`;
		case "unlock":
			return "解鎖手機時";
		case "battery_low":
			return "電量低時";
		case "timezone":
			return "換時區時";
		case "photo":
			return `拍了新照片${when.album ? `（${when.album}）` : ""}時`;
		case "bluetooth":
			return `${when.on === "connect" ? "連上" : "斷開"}藍牙「${when.device}」時`;
		case "activity":
			return `${ACTIVITY_NAMES[when.activity][when.on === "start" ? 0 : 1]}時`;
	}
}

function guardsFor(when: When, chosen: readonly GuardId[] | undefined): { guards?: GuardId[] } {
	const guards = chosen ?? (when.kind === "notification" ? DEFAULT_GUARDS : []);
	return guards.length > 0 ? { guards: [...new Set(guards)] } : {};
}

const hhmm = (value: string, name: string) => parseClock(value, name).text;

function summary(trigger: Trigger): string {
	const kind = trigger.kind === "followup" ? "follow-up" : "schedule";
	const at = trigger.when.kind === "once" ? `, at ${localTime(trigger.when.at)}` : "";
	const asked = `${trigger.guards?.length ? `, checks: ${trigger.guards.join(" ")}` : ""}${trigger.onlyIf ? `, only if: ${trigger.onlyIf}` : ""}`;
	return `- ${trigger.id}: ${trigger.name} (${describeWhen(trigger.when)}${at}${asked}, ${kind}${trigger.enabled ? "" : ", paused"}): ${trigger.prompt}`;
}

const oneDialogAtATime = serially();

async function needLocationAlways(what: string): Promise<void> {
	const { background } = await oneDialogAtATime(() => Triggers.requestLocationAlways());
	if (!background) {
		throw new Error(
			`pi needs location "allow all the time" to know ${what} while it is not open, and the user has not allowed it. Tell them: 設定 › 應用程式 › pi mobile › 權限 › 位置資訊 › 一律允許, then ask again.`,
		);
	}
}

export interface TriggerHost {
	changed(): void;
	notify(title: string, text: string, conversationId: ConversationId): Promise<boolean>;
}

const CreateScheduleArgs = Type.Object({
	name: Type.String({ description: "Short name shown to the user, such as 早晨簡報" }),
	prompt: Type.String({ description: "What to do when it fires, written as an instruction to yourself" }),
	on: Type.Union(
		[
			Type.Literal("time"),
			Type.Literal("headphones"),
			Type.Literal("charging"),
			Type.Literal("wifi"),
			Type.Literal("arrive"),
			Type.Literal("leave"),
			Type.Literal("notification"),
			Type.Literal("unlock"),
			Type.Literal("battery_low"),
			Type.Literal("timezone"),
			Type.Literal("photo"),
			Type.Literal("bluetooth_connect"),
			Type.Literal("bluetooth_disconnect"),
			Type.Literal("activity_start"),
			Type.Literal("activity_stop"),
		],
		{
			description:
				"time: at time (recurring) or at (once). Or an event: headphones connect, the phone starts charging, a Wi-Fi connects, the phone arrives at or leaves place, another app posts a notification (its app, sender and text come with the run), the user unlocks the phone, the battery runs low, the time zone changes (travel), a new photo or screenshot is saved (its album and ids come with the run), a Bluetooth device such as a car connects or disconnects, an activity starts or stops (walking, running, cycling, in a vehicle, still); days, from, until apply too",
		},
	),
	time: Type.Optional(Type.String({ description: "Recurring: 24-hour local time HH:MM" })),
	days: Type.Optional(Type.Array(oneOf(WEEKDAYS), { description: "Recurring: weekdays; omit for every day" })),
	at: Type.Optional(Type.String({ description: "One-time: local date and time YYYY-MM-DD HH:MM; give either time or at" })),
	wifi_name: Type.Optional(Type.String({ description: "With on wifi: only this network (its SSID); omit for any Wi-Fi" })),
	place: Type.Optional(Type.String({ description: "With on arrive or leave: an address or place name, or lat,lon; the user's home or office from memory" })),
	app: Type.Optional(Type.String({ description: "With on notification: only from this app, by its name or package, such as LINE" })),
	contains: Type.Optional(Type.String({ description: "With on notification: only when its title, sender or text contains this" })),
	album: Type.Optional(Type.String({ description: "With on photo: only photos in this album, such as Camera or Screenshots" })),
	device: Type.Optional(Type.String({ description: "With on bluetooth_connect or bluetooth_disconnect: part of the device's name, such as the car's" })),
	activity: Type.Optional(oneOf(ACTIVITIES, { description: "With on activity_start or activity_stop" })),
	radius_m: Type.Optional(Type.Integer({ minimum: 100, description: "With arrive or leave: how near counts, in meters (default 200)" })),
	from: Type.Optional(Type.String({ description: "With on: only from this local time HH:MM" })),
	until: Type.Optional(Type.String({ description: "With on: only until this local time HH:MM" })),
	guards: Type.Optional(
		Type.Array(oneOf(GUARD_IDS), {
			description:
				"With an event: built-in checks a small classifier makes before you are woken; the run is skipped when one fails. instructions: the text tries to instruct an AI (prompt injection); secrets: it holds a one-time code, password or key; ads: advertising or bulk marketing; attention: skip unless the user needs to act or reply. Default for notification: instructions and secrets; [] for none. Prefer these to only_if",
		}),
	),
	only_if: Type.Optional(
		Type.String({
			description:
				"With an event: a yes/no question about it that a small classifier answers before you are woken; the run happens only when the answer is likely yes. For what app and contains cannot tell, such as \"Does this message need a reply?\" or \"Is it about money?\"",
		}),
	),
	at_most_every_hours: Type.Optional(Type.Integer({ minimum: 1, maximum: 24, description: "With on: at most one run per this many hours; default 4; 24 means once per day (the first time that day)" })),
});
type CreateScheduleArgs = Static<typeof CreateScheduleArgs>;

async function needBluetooth(cannot: string): Promise<void> {
	const { granted } = await oneDialogAtATime(() => Triggers.requestBluetooth());
	if (!granted) throw new Error(`the user did not allow pi to see Bluetooth connections, so it cannot tell ${cannot}. Ask them to allow 鄰近裝置 for pi if they want it.`);
}

async function needAccess(to: "photos" | "activity", cannot: string, allow: string): Promise<void> {
	const { granted } = await oneDialogAtATime(() => Triggers.requestAccess({ to }));
	if (!granted) throw new Error(`the user did not allow pi to ${cannot}. Ask them to allow ${allow} for pi if they want it.`);
}

export async function whenOf(args: CreateScheduleArgs): Promise<When> {
	const days = (args.days ?? []).map((day) => WEEKDAYS.indexOf(day) + 1);
	if (args.on === "time") return timeOf(args, days);
	const window = {
		days,
		...(args.from ? { from: hhmm(args.from, "from") } : {}),
		...(args.until ? { until: hhmm(args.until, "until") } : {}),
		gapHours: args.at_most_every_hours ?? 4,
	};
	switch (args.on) {
		case "headphones":
			await needBluetooth("when headphones connect; wired headphones still work while pi runs");
			return { kind: "headphones", ...window };
		case "unlock":
		case "battery_low":
		case "timezone":
		case "charging":
			return { kind: args.on, ...window };
		case "photo":
			await needAccess("photos", "see photos, so it cannot tell when a new one is saved", "相片");
			return { kind: "photo", ...(args.album ? { album: args.album } : {}), ...window };
		case "bluetooth_connect":
		case "bluetooth_disconnect": {
			if (!args.device) throw new Error(`${args.on} needs device`);
			await needBluetooth("which device connected");
			return { kind: "bluetooth", on: args.on === "bluetooth_connect" ? "connect" : "disconnect", device: args.device, ...window };
		}
		case "activity_start":
		case "activity_stop": {
			if (!args.activity) throw new Error(`${args.on} needs activity`);
			await needAccess("activity", "recognize activity, so it cannot tell when they start walking or driving", "體能活動");
			return { kind: "activity", on: args.on === "activity_start" ? "start" : "stop", activity: args.activity, ...window };
		}
		case "notification":
			await requireAccess();
			return { kind: "notification", ...(args.app ? { app: args.app } : {}), ...(args.contains ? { contains: args.contains } : {}), ...window };
		case "wifi":
			if (args.wifi_name) await needLocationAlways("which Wi-Fi it is");
			return { kind: "wifi", ...(args.wifi_name ? { ssid: args.wifi_name } : {}), ...window };
		case "arrive":
		case "leave": {
			if (!args.place) throw new Error("arrive and leave need place");
			const point = await resolvePlace(args.place);
			await needLocationAlways("where the phone is");
			return { kind: "place", on: args.on, label: args.place, latitude: point.latitude, longitude: point.longitude, radius: args.radius_m ?? 200, ...window };
		}
	}
}

async function runningOnlyNote(when: When): Promise<string> {
	if (when.kind !== "unlock" && when.kind !== "battery_low") return "";
	if ((await Notifications.status()).allowed) return "";
	return " It works only while pi is running: Android tells only a running app about this, and pi keeps running in the background once the user turns on 通知讀取 (設定 › 手機). Tell the user.";
}

function timeOf(args: CreateScheduleArgs, days: number[]): When {
	if (args.only_if || args.guards?.length) throw new Error("guards and only_if are for events; a time needs no checks");
	if (args.at && !args.time) {
		const { ms: at, hasTime } = parseLocalTime(args.at, "at");
		if (!hasTime) throw new Error("at needs a time: YYYY-MM-DD HH:MM");
		if (at <= Date.now()) throw new Error(`${args.at} is in the past`);
		return { kind: "once", at };
	}
	if (args.time && !args.at) return { kind: "daily", time: hhmm(args.time, "time"), days };
	throw new Error("give either time (recurring) or at (one-time)");
}

export function createTriggerExtension(host: TriggerHost) {
	const createSchedule = defineAppTool({
		name: "create_schedule",
		description:
			"Schedule a recurring or one-time run of yourself: at a time (on: time, with time or at), or on an event the phone notices (see on), the prompt is sent to you in this conversation as a new turn, even if the user is not using the phone, so you can compare with earlier runs. For a reminder that needs no work, set_alarm is enough.",
		parameters: CreateScheduleArgs,
		execute: async (args, api, context) => {
			const when = await whenOf(args);
			const existing = await api.snapshot(TriggerDoc, context);
			if ((existing?.items.length ?? 0) >= MAX_TRIGGERS) throw new Error(`there are already ${MAX_TRIGGERS} schedules; delete one first`);
			const trigger: Trigger = {
				id: crypto.randomUUID().slice(0, 8),
				name: args.name,
				prompt: args.prompt,
				when,
				...(args.only_if ? { onlyIf: args.only_if } : {}),
				...guardsFor(when, args.guards),
				kind: "schedule",
				conversationId: api.conversationId,
				enabled: true,
				createdAt: Date.now(),
			};
			await api.commit(async (tx) => {
				(await tx.doc(TriggerDoc)).items.push(trigger);
			}, context);
			host.changed();
			const asked = `${trigger.guards?.length ? ` Checks: ${trigger.guards.join(", ")}.` : ""}${trigger.onlyIf ? ` Only if: ${trigger.onlyIf}` : ""}`;
			return text(`Scheduled ${trigger.id}: ${trigger.name}, ${describeWhen(when)}.${asked} The user can pause or delete it in Settings.${await runningOnlyNote(when)}`);
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
			const shown = await host.notify(args.title, args.text, api.conversationId);
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

export interface TriggerState {
	items: Trigger[];
	next: Record<string, number>;
}

const RUNS_KEPT_MS = 24 * 60 * 60 * 1000;

const context = BACKGROUND_CONTEXT;

export class TriggerRuns {
	readonly #harness: Harness;
	readonly #bots: () => Promise<readonly { id: ConversationId; avatar: string }[]>;
	readonly #touchBot: (id: ConversationId, at: number) => Promise<void>;
	readonly #judge: Judge;
	readonly #listeners = new Set<(state: TriggerState) => void>();
	#state: TriggerState = { items: [], next: {} };
	readonly #started = new Set<ConversationId>();

	constructor(
		harness: Harness,
		bots: () => Promise<readonly { id: ConversationId; avatar: string }[]>,
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
			.filter((item) => item.enabled && !item.fired)
			.map(({ id, name, when, conversationId }) => ({ id, name, when, avatar: avatars.get(conversationId) }));
		const next = nativeTriggers ? (await Triggers.sync({ schedules })).next : {};
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

	setEnabled(id: string, enabled: boolean): Promise<void> {
		return this.#edit((items) => items.map((item) => (item.id === id ? { ...item, enabled } : item)));
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
		if (!trigger || (delivery !== "manual" && !trigger.enabled)) return undefined;
		if (trigger.when.kind === "once" && delivery !== "manual" && !trigger.fired) await this.#markFired(id);
		const today = startOfToday();
		const runsToday = (doc?.runs ?? []).filter((run) => run.at >= today);
		const overLimit =
			delivery !== "manual" &&
			(runsToday.filter((run) => run.trigger === id).length >= LIMITS.perTrigger || runsToday.length >= LIMITS.total);
		const conversation = !overLimit && (await this.#bots()).some((bot) => bot.id === trigger.conversationId) ? await this.#harness.conversation(trigger.conversationId, context) : undefined;
		const now = Date.now();
		if (!conversation) {
			await this.#record(id, { at: now, delivery, error: overLimit ? "今天的執行次數已達上限" : "它的 Bot 已經刪除" });
			return undefined;
		}
		const conversationId = trigger.conversationId;
		const event = trigger.when.kind !== "daily" && trigger.when.kind !== "once" && delivery !== "manual";
		const heard = event ? (delivered.device ?? trigger.when.kind) : undefined;
		const guards = trigger.guards ?? [];
		const screening =
			heard && (guards.length > 0 || trigger.onlyIf)
				? screen(guards, trigger.onlyIf, await this.#judge.ask(screeningQuestions(guards, trigger.onlyIf), { automation: trigger.name, purpose: trigger.prompt, event: heard }))
				: undefined;
		if (screening && !screening.pass) {
			const skipped = { reason: screening.reason, ...(screening.probability !== undefined ? { probability: screening.probability } : {}) };
			await this.#record(id, { at: now, delivery, skipped, ...(screening.unjudged ? { unjudged: screening.unjudged } : {}) });
			if (nativeTriggers) await Triggers.skipped({ trigger: id });
			return undefined;
		}
		const judged: { judged?: number } = screening?.judged !== undefined ? { judged: screening.judged } : {};
		const unjudged: { unjudged?: string } = screening?.unjudged ? { unjudged: screening.unjudged } : {};
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
			await this.#record(id, { at: now, delivery, error: `沒有送出，會再試：${messageOf(error)}` });
			throw error;
		}
		this.#started.add(conversationId);
		await this.#touchBot(conversationId, now);
		await this.#record(id, { at: now, delivery, ...judged, ...unjudged }, request);
		return conversationId;
	}

	gaveUp(id: string, reason: string): Promise<void> {
		return this.#record(id, { at: Date.now(), delivery: "later", error: `一天內都沒有送出，這次跳過：${reason}` });
	}

	async #markFired(id: string): Promise<void> {
		await this.#harness.commit(async (tx) => {
			const item = (await tx.doc(TriggerDoc)).items.find((candidate) => candidate.id === id);
			if (item) item.fired = true;
		}, context);
	}

	async #record(id: string, last: NonNullable<Trigger["last"]>, request?: string): Promise<void> {
		const kept = startOfToday() - RUNS_KEPT_MS;
		await this.#harness.commit(async (tx) => {
			const triggers = await tx.doc(TriggerDoc);
			const item = triggers.items.find((candidate) => candidate.id === id);
			if (!item) return;
			item.last = last;
			if (last.error !== undefined || last.skipped) return;
			if (request && triggers.runs.some((run) => run.request === request)) return;
			triggers.runs = [...triggers.runs.filter((run) => run.at >= kept), { trigger: id, at: last.at, ...(request ? { request } : {}) }];
			if (item.when.kind === "once" && last.delivery !== "manual") triggers.items = triggers.items.filter((candidate) => candidate.id !== id);
		}, context);
		await this.sync();
	}

	takeStarted(id: ConversationId): boolean {
		return this.#started.delete(id);
	}
}
