// Controlling the phone through notification access (NotificationsPlugin.java): what plays in media apps and its
// transport, and Do Not Disturb. Notification access is what Android lets a listener do both with, so no other
// permission is asked for.
import { Type } from "typebox";
import { defineExtension } from "@earendil-works/pi-durable";
import { type DndMode, Notifications } from "../../notifications-plugin.ts";
import { defineAppTool, localTime, parseNextTime, text } from "./common.ts";
import { requireAccess } from "./notifications.ts";
const minutes = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;

const media = defineAppTool({
	name: "media",
	description: "See what is playing in media apps (Spotify, YouTube Music, podcasts) or control it: play, pause, next, previous. Without app, the most recent player.",
	parameters: Type.Object({
		action: Type.Union([Type.Literal("status"), Type.Literal("play"), Type.Literal("pause"), Type.Literal("next"), Type.Literal("previous")], { description: "status reads what plays; the rest control it" }),
		app: Type.Optional(Type.String({ description: "Only this app, by name, such as Spotify" })),
	}),
	execute: async (args) => {
		await requireAccess();
		const { items } = await Notifications.media();
		const sessions = args.app ? items.filter((item) => `${item.app} ${item.package}`.toLowerCase().includes(args.app?.toLowerCase() ?? "")) : items;
		if (args.action === "status") {
			if (sessions.length === 0) return text("Nothing is playing or paused.");
			return text(
				sessions
					.map((item) => {
						const track = [item.title, item.artist, item.album].filter(Boolean).join(" · ");
						const time = item.durationMs ? ` (${minutes(item.positionMs ?? 0)} / ${minutes(item.durationMs)})` : "";
						return `${item.app}: ${item.state}${track ? ` — ${track}` : ""}${time}`;
					})
					.join("\n"),
			);
		}
		const target = sessions[0];
		if (!target) return text(args.app ? `${args.app} has no player open.` : "No app has a player open.");
		await Notifications.mediaControl({ action: args.action, package: target.package });
		return text(`${args.action} in ${target.app}.`);
	},
});

const MODES: Record<DndMode, string> = { off: "off", priority: "priority only", alarms: "alarms only", silent: "total silence" };

const doNotDisturb = defineAppTool({
	name: "do_not_disturb",
	description:
		"Read or set Do Not Disturb. priority lets the user's important people and apps through (their usual 勿擾), alarms only alarms, silent nothing. With until, it turns itself off then.",
	parameters: Type.Object({
		mode: Type.Union([Type.Literal("status"), Type.Literal("off"), Type.Literal("priority"), Type.Literal("alarms"), Type.Literal("silent")], { description: "status reads it; the rest set it" }),
		until: Type.Optional(Type.String({ description: 'Local time to turn it off, such as "07:00" (the next one) or "2026-10-23 07:00"' })),
	}),
	execute: async (args) => {
		await requireAccess();
		if (args.mode === "status") {
			const { mode, until } = await Notifications.dnd();
			return text(`Do Not Disturb: ${mode === "unknown" ? mode : MODES[mode]}${until ? `, until ${localTime(until)}` : ""}.`);
		}
		const until = args.until ? parseNextTime(args.until, "until") : undefined;
		await Notifications.setDnd({ mode: args.mode, ...(until ? { until } : {}) });
		return text(`Do Not Disturb ${MODES[args.mode]}${until && args.mode !== "off" ? ` until ${localTime(until)}` : ""}.`);
	},
});

export const ControlExtension = defineExtension({ name: "phone_control", tools: [media, doNotDisturb] });
