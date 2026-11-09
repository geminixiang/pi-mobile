import { App } from "@capacitor/app";
import { Apps } from "../../plugins/apps.ts";
import { PhoneScreen } from "../../phone-screen/plugin.ts";
import { native } from "../../native.ts";
import { Type } from "typebox";
import { type ConversationId, defineExtension } from "@earendil-works/pi-durable";
import { appSection } from "../section.ts";
import { defineAppTool, text } from "./common.ts";
import { parseClock } from "../../time.ts";
import { oneOf } from "../../parse.ts";
import { toBase64 } from "../../encoding.ts";
import { mimeTypeOf } from "../mime.ts";

const BACKGROUND = "pi is in the background, and the phone does not let it open other apps from there. Ask the user to open pi and try again.";

export type ActsAsUser = (conversationId: ConversationId) => Promise<boolean>;

export async function mayOpenScreen(actsAsUser: ActsAsUser, conversationId: ConversationId): Promise<boolean> {
	if ((await App.getState()).isActive) return true;
	// why: Android lets an app whose accessibility service is bound start activities from the background (measured on the S24, Android 16); only a bot the user lets act as them may use it
	const screenControl = native.implements(PhoneScreen.status) && (await PhoneScreen.status()).allowed;
	return screenControl && (await actsAsUser(conversationId));
}

export async function openScreen(actsAsUser: ActsAsUser, conversationId: ConversationId): Promise<void> {
	if (!(await mayOpenScreen(actsAsUser, conversationId))) throw new Error(BACKGROUND);
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

const TRAVEL_MODES = ["driving", "walking", "transit", "bicycling"] as const;

const BLOCKED_SCHEMES = new Set(["intent", "file", "content", "javascript", "data", "about", "blob", "android-app", "pimobile", "dev.geminixiang.pimobile"]);

const MAX_SHARE_BYTES = 15 * 1024 * 1024;

export type AppFile = { fileBase64: string; fileName: string; mimeType: string };

export function appFile(fileName: string, bytes: Uint8Array): AppFile {
	return { fileBase64: toBase64(bytes), fileName, mimeType: mimeTypeOf(fileName) ?? "application/octet-stream" };
}

const setAlarm = defineAppTool({
	name: "set_alarm",
	groups: ["apps"],
	effect: "direct",
	needs: [Apps.setAlarm],
	description: "Set an alarm in the phone's clock app, without opening it. Time is the phone's local time.",
	parameters: Type.Object({
		time: Type.String({ description: "24-hour local time, HH:MM" }),
		label: Type.Optional(Type.String({ description: "Shown when it rings" })),
		repeat: Type.Optional(Type.Array(oneOf(WEEKDAYS), { description: "Weekdays to repeat on; omit for once" })),
	}),
	execute: async (args) => {
		const { hour, minute } = parseClock(args.time, "time");
		const days = args.repeat?.map((day) => WEEKDAYS.indexOf(day) + 1);
		await Apps.setAlarm({ hour, minute, label: args.label, days });
		return text(`Alarm set for ${args.time}${days ? ` repeating ${args.repeat?.join(", ")}` : ""}.`);
	},
});

const openAlarms = defineAppTool({
	name: "open_alarms",
	groups: ["apps"],
	effect: "screen",
	needs: [Apps.openAlarms],
	description:
		"Open the clock app's alarm list. No app can turn off or delete alarms there for the user, so they do it on that screen; if tool_search lists phone_act_as_user, you can do it there yourself.",
	parameters: Type.Object({}),
	execute: async () => {
		await Apps.openAlarms();
		return text("Opened the alarm list. An alarm changes only when it is turned off or deleted on that screen.");
	},
});

const setTimer = defineAppTool({
	name: "set_timer",
	groups: ["apps"],
	effect: "direct",
	needs: [Apps.setTimer],
	description: "Start a countdown timer in the phone's clock app, without opening it.",
	parameters: Type.Object({
		seconds: Type.Integer({ minimum: 1, maximum: 86_400, description: "How long, in seconds" }),
		label: Type.Optional(Type.String({ description: "Shown when it ends" })),
	}),
	execute: async (args) => {
		await Apps.setTimer({ seconds: args.seconds, label: args.label });
		return text(`Timer started for ${args.seconds} seconds.`);
	},
});

const composeEmail = defineAppTool({
	name: "compose_email",
	groups: ["apps"],
	effect: "screen",
	needs: [Apps.composeEmail],
	description: "Open the phone's email app on a draft. The user reviews it and sends it; nothing is sent by this tool.",
	parameters: Type.Object({
		to: Type.Optional(Type.Array(Type.String(), { description: "Email addresses" })),
		subject: Type.Optional(Type.String({ description: "Subject line" })),
		body: Type.String({ description: "The email, as the user would write it" }),
	}),
	execute: async (args) => {
		await Apps.composeEmail({ to: args.to ?? [], subject: args.subject, body: args.body });
		return text("Opened an email draft. It is sent only if the user presses send.");
	},
});

const composeSms = defineAppTool({
	name: "compose_sms",
	groups: ["apps"],
	effect: "screen",
	needs: [Apps.composeSms],
	description: "Open the phone's messaging app on a text message draft. The user sends it; nothing is sent by this tool.",
	parameters: Type.Object({
		to: Type.Optional(Type.String({ description: "Phone number" })),
		body: Type.String({ description: "The message, as the user would write it" }),
	}),
	execute: async (args) => {
		await Apps.composeSms({ to: args.to ?? "", body: args.body });
		return text("Opened a message draft. It is sent only if the user presses send.");
	},
});

const openMaps = defineAppTool({
	name: "open_maps",
	groups: ["apps"],
	effect: "screen",
	needs: [Apps.open],
	description: "Open directions to a place in Google Maps (or the phone's maps app). The user starts navigation there.",
	parameters: Type.Object({
		destination: Type.String({ description: "Address, place name, or lat,lng" }),
		origin: Type.Optional(Type.String({ description: "Default: current location" })),
		mode: Type.Optional(oneOf(TRAVEL_MODES, { description: "How the user goes; default the maps app's" })),
	}),
	execute: async (args) => {
		const url = new URL("https://www.google.com/maps/dir/");
		url.searchParams.set("api", "1");
		url.searchParams.set("destination", args.destination);
		if (args.origin) url.searchParams.set("origin", args.origin);
		if (args.mode) url.searchParams.set("travelmode", args.mode);
		await Apps.open({ uri: url.toString() });
		return text(`Opened directions to ${args.destination}.`);
	},
});

const openLink = defineAppTool({
	name: "open_link",
	groups: ["apps"],
	effect: "screen",
	needs: [Apps.open],
	description:
		"Open a URL or an app deep link (for example https://…, geo:, tel: which opens the dialer without calling, market://, spotify:…) in the app that handles it.",
	parameters: Type.Object({ url: Type.String({ description: "With its scheme, such as https:// or geo:" }) }),
	execute: async (args) => {
		const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(args.url.trim())?.[1]?.toLowerCase();
		if (!scheme) throw new Error("url needs a scheme, such as https:");
		if (BLOCKED_SCHEMES.has(scheme)) throw new Error(`${scheme}: links are not allowed`);
		await Apps.open({ uri: args.url.trim() });
		return text(`Opened ${args.url}.`);
	},
});

const share = defineAppTool({
	name: "share",
	groups: ["apps"],
	effect: "screen",
	needs: [Apps.share],
	description:
		"Open the phone's share sheet with text and/or one file from your folder (on the phone, or in the sandbox when there is one), so the user can send it to another app (LINE, Drive, email…). The user picks the target.",
	parameters: Type.Object({
		text: Type.Optional(Type.String({ description: "Text to share" })),
		path: Type.Optional(Type.String({ description: "File in your folder to share, as read takes it, e.g. report.csv" })),
		title: Type.Optional(Type.String({ description: "Title of the share sheet" })),
	}),
	execute: async (args, api, context) => {
		if (!args.text && !args.path) throw new Error("give text, path, or both");
		let file: AppFile | undefined;
		if (args.path) {
			if (!api.env) throw new Error("this bot has no folder");
			const absolute = await api.env.absolutePath(args.path, context);
			if (!absolute.ok) throw new Error(`cannot read ${args.path}: ${absolute.error.message}`);
			const read = await api.env.readBinaryFile(absolute.value, context);
			if (!read.ok) throw new Error(`cannot read ${args.path}: ${read.error.message}`);
			if (read.value.byteLength > MAX_SHARE_BYTES) throw new Error(`file is larger than ${MAX_SHARE_BYTES / 1024 / 1024} MB`);
			file = appFile(absolute.value.split("/").pop() || "file", read.value);
		}
		await Apps.share({ text: args.text, title: args.title, ...file });
		return text("Opened the share sheet. The user picks where it goes.");
	},
});

export const AppsExtension = defineExtension({
	name: "apps",
	tools: [setAlarm, openAlarms, setTimer, composeEmail, composeSms, openMaps, openLink, share],
	sections: [
		appSection("apps", 400, () => "Drafts and shares open a screen the user finishes (never say it was sent); open other apps only when the user asks to go, open, call, or send.", { about: [setAlarm, openAlarms, setTimer, composeEmail, composeSms, openMaps, openLink, share] }),
	],
});
