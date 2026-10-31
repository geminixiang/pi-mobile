import type { Context } from "@earendil-works/chord";
import { type ConversationId, defineExtension, section, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";
import { defineAppTool, localTime, parseClock, parseLocalTime, text } from "../agent/tools/common.ts";
import { oneOf } from "../agent/parse.ts";
import { resolvePlace } from "../agent/tools/device.ts";
import { requireAccess } from "../agent/notification-access.ts";
import { Notifications } from "../plugins/notifications.ts";
import { serially } from "../promise.ts";
import { DEFAULT_GUARDS, GUARD_IDS, type GuardId } from "../agent/guards.ts";
import { ACTIVITIES, Triggers, type When } from "./plugin.ts";
import { type Trigger, TriggerDoc } from "./runs.ts";
import { describeWhen } from "./when.ts";

const MAX_TRIGGERS = 20;
const MAX_FOLLOWUPS = 5;

const RUNNING_ONLY =
	" It works only while pi is running: Android tells only a running app about this, and pi keeps running in the background once the user turns on 通知讀取 (設定 › 手機). Tell the user.";

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

function guardsFor(when: When, chosen: readonly GuardId[] | undefined): { guards?: GuardId[] } {
	const guards = chosen ?? (when.kind === "notification" ? DEFAULT_GUARDS : []);
	return guards.length > 0 ? { guards: [...new Set(guards)] } : {};
}

const hhmm = (value: string, name: string) => parseClock(value, name).text;

function summary(trigger: Trigger): string {
	const kind = trigger.kind === "followup" ? "follow-up" : "schedule";
	const at = trigger.when.kind === "once" ? `, at ${localTime(trigger.when.at)}` : "";
	const asked = `${trigger.guards?.length ? `, checks: ${trigger.guards.join(" ")}` : ""}${trigger.onlyIf ? `, only if: ${trigger.onlyIf}` : ""}`;
	return `- ${trigger.id}: ${trigger.name} (${describeWhen(trigger.when)}${at}${asked}, ${kind}${trigger.state === "paused" ? ", paused" : ""}): ${trigger.prompt}`;
}

const oneDialogAtATime = serially();

async function needLocationAlways(what: string): Promise<void> {
	const { background } = await oneDialogAtATime(() => Triggers.requestLocationAlways());
	if (!background) {
		throw new Error(
			`pi needs location "allow all the time" to know ${what} while it is not open, and the user has not allowed it. Tell them: 設定 › 應用程式 › Pi › 權限 › 位置資訊 › 一律允許, then ask again.`,
		);
	}
}

export type Notified = "shown" | "watching" | "off";

export interface TriggerHost {
	changed(): void;
	notify(title: string, text: string, conversationId: ConversationId): Promise<Notified>;
}

const CreateScheduleArgs = Type.Object({
	name: Type.String({ description: "Short name shown to the user, such as 早晨簡報" }),
	prompt: Type.String({ description: "What to do when it fires, written as an instruction to yourself" }),
	on: oneOf(
		[
			"time",
			"headphones",
			"charging",
			"wifi",
			"arrive",
			"leave",
			"notification",
			"unlock",
			"battery_low",
			"timezone",
			"photo",
			"bluetooth_connect",
			"bluetooth_disconnect",
			"activity_start",
			"activity_stop",
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
	const add = async (api: ToolExecutionApi, context: Context, fields: Pick<Trigger, "name" | "prompt" | "when" | "onlyIf" | "guards"> & { kind: "schedule" | "followup" }): Promise<Trigger> => {
		const trigger: Trigger = { id: crypto.randomUUID().slice(0, 8), ...fields, conversationId: api.conversationId, state: "on", createdAt: Date.now() };
		await api.commit(async (tx) => {
			(await tx.doc(TriggerDoc)).items.push(trigger);
		}, context);
		host.changed();
		return trigger;
	};

	const createSchedule = defineAppTool({
		name: "create_schedule",
		effect: "direct",
		needs: [Triggers.sync],
		description:
			"Schedule a recurring or one-time run of yourself: at a time (on: time, with time or at), or on an event the phone notices (see on), the prompt is sent to you in this conversation as a new turn, even if the user is not using the phone, so you can compare with earlier runs. For a reminder that needs no work, set_alarm is enough.",
		parameters: CreateScheduleArgs,
		execute: async (args, api, context) => {
			const when = await whenOf(args);
			const runningOnly = (when.kind === "unlock" || when.kind === "battery_low") && !(await Notifications.status()).allowed;
			const existing = await api.snapshot(TriggerDoc, context);
			if ((existing?.items.length ?? 0) >= MAX_TRIGGERS) throw new Error(`there are already ${MAX_TRIGGERS} schedules; delete one first`);
			const trigger = await add(api, context, {
				name: args.name,
				prompt: args.prompt,
				when,
				...(args.only_if ? { onlyIf: args.only_if } : {}),
				...guardsFor(when, args.guards),
				kind: "schedule",
			});
			const asked = `${trigger.guards?.length ? ` Checks: ${trigger.guards.join(", ")}.` : ""}${trigger.onlyIf ? ` Only if: ${trigger.onlyIf}` : ""}`;
			return text(`Scheduled ${trigger.id}: ${trigger.name}, ${describeWhen(when)}.${asked} The user can pause or delete it in Settings.${runningOnly ? RUNNING_ONLY : ""}`);
		},
	});

	const scheduleFollowup = defineAppTool({
		name: "schedule_followup",
		effect: "direct",
		needs: [Triggers.sync],
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
			const trigger = await add(api, context, { name: args.label, prompt: args.note, when: { kind: "once", at }, kind: "followup" });
			return text(`Follow-up ${trigger.id} at ${localTime(at)}.`);
		},
	});

	const listSchedules = defineAppTool({
		name: "list_schedules",
		effect: "read",
		needs: [Triggers.sync],
		description: "Your schedules and pending follow-ups, with their ids.",
		parameters: Type.Object({}),
		execute: async (_args, api, context) => {
			const items = ((await api.snapshot(TriggerDoc, context))?.items ?? []).filter((item) => item.conversationId === api.conversationId);
			return text(items.length > 0 ? items.map(summary).join("\n") : "No schedules.");
		},
	});

	const deleteSchedule = defineAppTool({
		name: "delete_schedule",
		effect: "direct",
		needs: [Triggers.sync],
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
		effect: "direct",
		needs: [Triggers.notify],
		description:
			"Show the user a phone notification that opens this conversation. Use it at the end of a triggered run when the result deserves their attention or the schedule asks for it; otherwise skip it when there is nothing new. Keep it to the gist; the full answer is in the conversation.",
		parameters: Type.Object({
			title: Type.String({ description: "Short, such as 早晨簡報" }),
			text: Type.String({ description: "One to three short lines" }),
		}),
		execute: async (args, api) => {
			const notified = await host.notify(args.title, args.text, api.conversationId);
			if (notified === "watching") return text("Delivered: the user has this conversation open and reads your answer.");
			if (notified === "off") return text("Not shown: notifications from pi are turned off on this phone. Put the gist in your answer, and tell the user they can turn them on in the phone's settings.");
			return text("Notified.");
		},
	});

	return defineExtension({
		name: "triggers",
		tools: [createSchedule, scheduleFollowup, listSchedules, deleteSchedule, notify],
		sections: [
			section("triggers", () =>
				[
					`A message starting "[trigger]" came from a schedule: answer briefly without mentioning the schedule or the notification, and notify the gist when it is worth it or the schedule asks for it.`,
					"Headphones connected: the user is listening, not reading: read the spoken-report skill and report with speak. Other events (charging, Wi-Fi, a place) say what happened.",
				].join("\n"),
			),
		],
	});
}
