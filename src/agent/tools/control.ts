import { Type } from "typebox";
import { defineExtension } from "@earendil-works/pi-durable";
import { requireAccess } from "../../notifications-plugin.ts";
import { DND_MODES, type DndMode, Notifications } from "../../plugins/notifications.ts";
import {
	type Connection,
	CONNECTIONS,
	type ConnectionsState,
	DISPLAY_SETTINGS,
	type DisplayState,
	PhoneState,
	type SoundState,
	STREAMS,
} from "../../plugins/phone-state.ts";
import { messageOf } from "../../promise.ts";
import { defineAppTool, localTime, pad, parseNextTime, text } from "./common.ts";
import { oneOf } from "../parse.ts";
const minutesSeconds = (ms: number) => `${Math.floor(ms / 60_000)}:${pad(Math.floor((ms % 60_000) / 1000))}`;

const media = defineAppTool({
	name: "media",
	effect: "direct",
	needs: [Notifications.status, Notifications.media, Notifications.mediaControl],
	description: "See what is playing in media apps (Spotify, YouTube Music, podcasts) or control it: play, pause, next, previous. Without app, the most recent player.",
	parameters: Type.Object({
		action: oneOf(["status", "play", "pause", "next", "previous"], { description: "status reads what plays; the rest control it" }),
		app: Type.Optional(Type.String({ description: "Only this app, by name, such as Spotify" })),
	}),
	execute: async (args) => {
		await requireAccess();
		const { items } = await Notifications.media();
		const app = args.app?.toLowerCase();
		const sessions = app ? items.filter((item) => `${item.app} ${item.package}`.toLowerCase().includes(app)) : items;
		if (args.action === "status") {
			if (sessions.length === 0) return text("Nothing is playing or paused.");
			return text(
				sessions
					.map((item) => {
						const track = [item.title, item.artist, item.album].filter(Boolean).join(" · ");
						const time = item.durationMs ? ` (${minutesSeconds(item.positionMs ?? 0)} / ${minutesSeconds(item.durationMs)})` : "";
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
	effect: "direct",
	needs: [Notifications.status, Notifications.dnd, Notifications.setDnd],
	description:
		"Read or set Do Not Disturb. priority lets the user's important people and apps through (their usual 勿擾), alarms only alarms, silent nothing. With until, it turns itself off then.",
	parameters: Type.Object({
		mode: oneOf(["status", ...DND_MODES], { description: "status reads it; the rest set it" }),
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

const NOTIFICATION_ACCESS =
	"Android lets pi change this only with notification access, since it touches Do Not Disturb. Tell the user to turn it on in pi's 設定 › 手機 › 通知讀取.";
const WRITE_SETTINGS =
	"Changing the screen needs Android's 「修改系統設定」 permission for pi, which is off. Tell the user to allow it in pi's 設定 › 手機 › 系統權限 › 修改系統設定.";

const KNOWN: Record<string, string> = { dnd: NOTIFICATION_ACCESS, "write-settings": WRITE_SETTINGS };

async function native<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		const message = messageOf(error);
		throw new Error(KNOWN[message] ?? message);
	}
}

const describeSound = (state: SoundState) =>
	`Ringer: ${state.ringer}. Volume: ${STREAMS.map((stream) => `${stream} ${state.volumePercent[stream]}%`).join(", ")}.`;

const sound = defineAppTool({
	name: "sound",
	effect: "direct",
	needs: [PhoneState.sound, PhoneState.setRinger, PhoneState.setVolume],
	description:
		"Read or change the phone's sound: the ringer (ring, vibrate, silent) and each volume as a percent (ring, media, alarm, notification, call). Raising the ring volume above 0 also switches the ringer to ring.",
	parameters: Type.Object({
		action: oneOf(["status", "ring", "vibrate", "silent", "volume"], { description: "status reads it; ring, vibrate, silent set the ringer; volume sets one volume" }),
		stream: Type.Optional(oneOf(STREAMS, { description: "volume: which one; default ring" })),
		percent: Type.Optional(Type.Integer({ minimum: 0, maximum: 100, description: "volume: 0 to 100" })),
	}),
	execute: async (args) => {
		if (args.action === "status") return text(describeSound(await native(() => PhoneState.sound())));
		if (args.action === "volume") {
			if (args.percent === undefined) throw new Error("volume needs percent");
			const percent = args.percent;
			return text(describeSound(await native(() => PhoneState.setVolume({ stream: args.stream ?? "ring", percent }))));
		}
		const mode = args.action === "ring" ? "normal" : args.action;
		return text(describeSound(await native(() => PhoneState.setRinger({ mode }))));
	},
});

const describeDisplay = (state: DisplayState) =>
	[
		state.brightnessPercent !== undefined ? `Brightness ${state.brightnessPercent}%${state.autoBrightness ? " (adaptive)" : ""}` : undefined,
		state.autoRotate !== undefined ? `auto-rotate ${state.autoRotate ? "on" : "off"}` : undefined,
		state.screenTimeoutSeconds !== undefined ? `screen turns off after ${state.screenTimeoutSeconds} s` : undefined,
	]
		.filter(Boolean)
		.join(", ") + (state.canChange ? "." : `. ${WRITE_SETTINGS}`);

const display = defineAppTool({
	name: "display",
	effect: "direct",
	needs: [PhoneState.display, PhoneState.setDisplay],
	description: "Read or change the screen: brightness, adaptive brightness, auto-rotate, and how long until it turns off.",
	parameters: Type.Object({
		action: oneOf(["status", ...DISPLAY_SETTINGS], { description: "status reads it; the rest change one setting" }),
		percent: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "brightness: 1 to 100; turns adaptive brightness off" })),
		on: Type.Optional(Type.Boolean({ description: "auto_brightness, auto_rotate: on or off" })),
		seconds: Type.Optional(Type.Integer({ minimum: 15, maximum: 1800, description: "screen_timeout: seconds" })),
	}),
	execute: async (args) => {
		if (args.action === "status") return text(describeDisplay(await native(() => PhoneState.display())));
		const value = args.action === "brightness" ? args.percent : args.action === "screen_timeout" ? args.seconds : undefined;
		if ((args.action === "brightness" || args.action === "screen_timeout") && value === undefined) {
			throw new Error(`${args.action} needs ${args.action === "brightness" ? "percent" : "seconds"}`);
		}
		if ((args.action === "auto_brightness" || args.action === "auto_rotate") && args.on === undefined) throw new Error(`${args.action} needs on`);
		const what = args.action;
		const on = args.on;
		return text(describeDisplay(await native(() => PhoneState.setDisplay({ what, ...(value !== undefined ? { value } : {}), ...(on !== undefined ? { on } : {}) }))));
	},
});

const flashlight = defineAppTool({
	name: "flashlight",
	effect: "direct",
	needs: [PhoneState.flashlight, PhoneState.setFlashlight],
	description: "Read or switch the phone's flashlight (the camera's torch), such as to light the way or find something in the dark.",
	parameters: Type.Object({ action: oneOf(["status", "on", "off"], { description: "status reads it" }) }),
	execute: async (args) => {
		const result = await native(() => (args.action === "status" ? PhoneState.flashlight() : PhoneState.setFlashlight({ on: args.action === "on" })));
		return text(`Flashlight: ${result.state}.`);
	},
});

const LABEL: Record<Connection, string> = {
	wifi: "Wi-Fi",
	bluetooth: "Bluetooth",
	mobile_data: "mobile data",
	airplane_mode: "airplane mode",
	location: "location",
	nfc: "NFC",
	battery_saver: "battery saver",
};

const describeConnections = (state: ConnectionsState) =>
	[
		`Wi-Fi ${state.wifi.on ? "on" : "off"}${state.wifi.connected ? `, connected${state.wifi.name ? ` to ${state.wifi.name}` : ""}` : ""}`,
		`Bluetooth ${state.bluetooth.on ? "on" : "off"}${state.bluetooth.connectedProfiles ? ` (connected: ${state.bluetooth.connectedProfiles})` : ""}`,
		`mobile data ${state.mobileData.on === true ? "on" : state.mobileData.on === false ? "off" : "unknown"}`,
		`airplane mode ${state.airplaneMode ? "on" : "off"}`,
		`location ${state.location ? "on" : "off"}`,
		`NFC ${state.nfc}`,
		`battery saver ${state.batterySaver ? "on" : "off"}`,
	].join("; ") + ".";

const connections = defineAppTool({
	name: "connections",
	effect: "direct",
	needs: [PhoneState.connections, PhoneState.setConnection],
	description:
		"Read or switch Wi-Fi (and the network it is on), Bluetooth, mobile data, airplane mode, location, NFC, and battery saver. Android lets apps only open these switches: with screen control on, pi taps it itself and checks; otherwise the switch is left on screen for the user.",
	parameters: Type.Object({
		action: oneOf(["status", "on", "off"], { description: "status reads them all; on and off switch one" }),
		what: Type.Optional(oneOf(CONNECTIONS, { description: "on, off: which one" })),
	}),
	execute: async (args) => {
		if (args.action === "status") return text(describeConnections(await native(() => PhoneState.connections())));
		const what = args.what;
		if (!what) throw new Error(`${args.action} needs what`);
		const on = args.action === "on";
		const state = await native(() => PhoneState.setConnection({ what, on }));
		const name = LABEL[what];
		const outcome =
			state.outcome === "already"
				? `${name} was already ${args.action}.`
				: state.outcome === "changed"
					? `${name} is now ${args.action}.`
					: state.outcome === "pressed"
						? `Tapped the ${name} switch; Android does not tell apps whether it is ${args.action} now.`
						: `Android lets apps only open the ${name} switch, so it is on the screen now; ${name} changes when the user taps it (screen control is off, so pi cannot).`;
		return text(`${outcome}\n${describeConnections(state)}`);
	},
});

export const ControlExtension = defineExtension({ name: "phone_control", tools: [media, doNotDisturb, sound, display, flashlight, connections] });
