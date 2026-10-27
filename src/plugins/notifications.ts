import { type Static, Type } from "typebox";
import { Allowed, definePlugin } from "./define.ts";
import { oneOf } from "../agent/parse.ts";

const RecordedNotification = Type.Object({
	package: Type.String(),
	app: Type.String(),
	conversation: Type.Optional(Type.String()),
	sender: Type.Optional(Type.String()),
	title: Type.String(),
	text: Type.String(),
	time: Type.Number(),
});
export type RecordedNotification = Static<typeof RecordedNotification>;

const ActiveNotification = Type.Object({
	key: Type.String(),
	app: Type.String(),
	title: Type.String(),
	text: Type.String(),
	time: Type.Number(),
	canReply: Type.Boolean(),
	clearable: Type.Boolean(),
});
export type ActiveNotification = Static<typeof ActiveNotification>;

const MediaSession = Type.Object({
	package: Type.String(),
	app: Type.String(),
	state: oneOf(["playing", "paused", "buffering", "stopped", "none", "other"]),
	title: Type.Optional(Type.String()),
	artist: Type.Optional(Type.String()),
	album: Type.Optional(Type.String()),
	durationMs: Type.Optional(Type.Number()),
	positionMs: Type.Optional(Type.Number()),
});

export const DND_MODES = ["off", "priority", "alarms", "silent"] as const;
export type DndMode = (typeof DND_MODES)[number];

export const Notifications = definePlugin("Notifications", {
	status: { args: Type.Object({}), result: Allowed },
	openSettings: { args: Type.Object({}) },
	list: {
		args: Type.Object({ since: Type.Optional(Type.Number()), app: Type.Optional(Type.String()), query: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer()) }),
		result: Type.Object({ items: Type.Array(RecordedNotification) }),
	},
	clear: { args: Type.Object({}) },
	active: { args: Type.Object({ app: Type.String(), conversation: Type.Optional(Type.String()) }), result: Type.Object({ items: Type.Array(ActiveNotification) }) },
	reply: { args: Type.Object({ key: Type.String(), text: Type.String() }) },
	dismiss: { args: Type.Object({ keys: Type.Array(Type.String()) }) },
	media: { args: Type.Object({}), result: Type.Object({ items: Type.Array(MediaSession) }) },
	mediaControl: {
		args: Type.Object({ action: oneOf(["play", "pause", "next", "previous", "stop"]), package: Type.Optional(Type.String()) }),
		result: Type.Object({ package: Type.String() }),
	},
	dnd: { args: Type.Object({}), result: Type.Object({ mode: oneOf([...DND_MODES, "unknown"]), until: Type.Number() }) },
	setDnd: { args: Type.Object({ mode: oneOf(DND_MODES), until: Type.Optional(Type.Number()) }) },
});
