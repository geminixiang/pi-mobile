import { type Static, Type } from "typebox";
import { Granted, definePlugin } from "../plugins/define.ts";
import { oneOf } from "../agent/parse.ts";

const Clock = Type.String({ pattern: "^\\d{2}:\\d{2}$" });
const Days = Type.Array(Type.Integer({ minimum: 1, maximum: 7 }));

const EventWindow = {
	days: Days,
	from: Type.Optional(Clock),
	until: Type.Optional(Clock),
	gapHours: Type.Integer({ minimum: 1, maximum: 24 }),
};

export const ACTIVITIES = ["walking", "running", "cycling", "vehicle", "still"] as const;

export const When = Type.Union([
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
	Type.Object({ kind: Type.Literal("bluetooth"), on: oneOf(["connect", "disconnect"]), device: Type.String(), ...EventWindow }),
	Type.Object({ kind: Type.Literal("activity"), on: oneOf(["start", "stop"]), activity: oneOf(ACTIVITIES), ...EventWindow }),
	Type.Object({
		kind: Type.Literal("place"),
		on: oneOf(["arrive", "leave"]),
		label: Type.String(),
		latitude: Type.Number(),
		longitude: Type.Number(),
		radius: Type.Number({ minimum: 100 }),
		...EventWindow,
	}),
]);
export type When = Static<typeof When>;

export const QueuedEvent = Type.Union([
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

export const Triggers = definePlugin(
	"Triggers",
	{
		sync: {
			args: Type.Object({ schedules: Type.Array(Type.Object({ id: Type.String(), name: Type.String(), when: When, avatar: Type.Optional(Type.String()) })) }),
			result: Type.Object({ next: Type.Record(Type.String(), Type.Number()) }),
		},
		events: { args: Type.Object({}), result: Type.Object({ events: Type.Array(Type.Unknown()) }) },
		ack: { args: Type.Object({ ids: Type.Array(Type.String()) }) },
		started: { args: Type.Object({ trigger: Type.String() }) },
		skipped: { args: Type.Object({ trigger: Type.String() }) },
		status: { args: Type.Object({}), result: Type.Object({ exactAlarms: Type.Boolean(), bluetooth: Type.Boolean(), overlay: Type.Boolean() }) },
		requestBluetooth: { args: Type.Object({}), result: Granted },
		requestAccess: { args: Type.Object({ to: oneOf(["photos", "activity"]) }), result: Granted },
		requestLocationAlways: { args: Type.Object({}), result: Type.Object({ foreground: Type.Boolean(), background: Type.Boolean() }) },
		requestExactAlarms: { args: Type.Object({}) },
		requestOverlay: { args: Type.Object({}) },
		notify: { args: Type.Object({ title: Type.String(), text: Type.String(), conversation: Type.Optional(Type.String()), avatar: Type.Optional(Type.String()) }) },
		report: { args: Type.Object({ conversation: Type.String(), bot: Type.String(), avatar: Type.String(), schedule: Type.String(), headline: Type.String(), text: Type.String(), at: Type.Number() }) },
		seen: { args: Type.Object({ conversation: Type.String() }) },
	},
	{ event: Type.Object({}) },
);
