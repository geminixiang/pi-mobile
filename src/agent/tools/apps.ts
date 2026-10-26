import { App } from "@capacitor/app";
import { Apps } from "../../plugins/apps.ts";
import { Type } from "typebox";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { defineAppTool, oneOf, parseClock, text } from "./common.ts";
import { toBase64 } from "../../encoding.ts";
import { mimeTypeOf } from "../../mime.ts";


async function launch(action: () => Promise<void>): Promise<void> {
	if (!(await App.getState()).isActive)
		throw new Error("pi is in the background, and the phone does not let it open other apps from there. Ask the user to open pi and try again.");
	await action();
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

const setAlarm = defineAppTool({
	name: "set_alarm",
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
		await launch(() => Apps.setAlarm({ hour, minute, label: args.label, days }));
		return text(`Alarm set for ${args.time}${days ? ` repeating ${args.repeat?.join(", ")}` : ""}.`);
	},
});

const setTimer = defineAppTool({
	name: "set_timer",
	effect: "direct",
	needs: [Apps.setTimer],
	description: "Start a countdown timer in the phone's clock app, without opening it.",
	parameters: Type.Object({
		seconds: Type.Integer({ minimum: 1, maximum: 86_400, description: "How long, in seconds" }),
		label: Type.Optional(Type.String({ description: "Shown when it ends" })),
	}),
	execute: async (args) => {
		await launch(() => Apps.setTimer({ seconds: args.seconds, label: args.label }));
		return text(`Timer started for ${args.seconds} seconds.`);
	},
});

const composeEmail = defineAppTool({
	name: "compose_email",
	effect: "screen",
	needs: [Apps.composeEmail],
	description: "Open the phone's email app on a draft. The user reviews it and sends it; nothing is sent by this tool.",
	parameters: Type.Object({
		to: Type.Optional(Type.Array(Type.String(), { description: "Email addresses" })),
		subject: Type.Optional(Type.String({ description: "Subject line" })),
		body: Type.String({ description: "The email, as the user would write it" }),
	}),
	execute: async (args) => {
		await launch(() => Apps.composeEmail({ to: args.to ?? [], subject: args.subject, body: args.body }));
		return text("Opened an email draft. It is sent only if the user presses send.");
	},
});

const composeSms = defineAppTool({
	name: "compose_sms",
	effect: "screen",
	needs: [Apps.composeSms],
	description: "Open the phone's messaging app on a text message draft. The user sends it; nothing is sent by this tool.",
	parameters: Type.Object({
		to: Type.Optional(Type.String({ description: "Phone number" })),
		body: Type.String({ description: "The message, as the user would write it" }),
	}),
	execute: async (args) => {
		await launch(() => Apps.composeSms({ to: args.to ?? "", body: args.body }));
		return text("Opened a message draft. It is sent only if the user presses send.");
	},
});

const TRAVEL_MODES = ["driving", "walking", "transit", "bicycling"] as const;

const openMaps = defineAppTool({
	name: "open_maps",
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
		await launch(() => Apps.open({ uri: url.toString() }));
		return text(`Opened directions to ${args.destination}.`);
	},
});

const BLOCKED_SCHEMES = new Set(["intent", "file", "content", "javascript", "data", "about", "blob", "android-app", "pimobile", "dev.geminixiang.pimobile"]);

const openLink = defineAppTool({
	name: "open_link",
	effect: "screen",
	needs: [Apps.open],
	description:
		"Open a URL or an app deep link (for example https://…, geo:, tel: which opens the dialer without calling, market://, spotify:…) in the app that handles it.",
	parameters: Type.Object({ url: Type.String({ description: "With its scheme, such as https:// or geo:" }) }),
	execute: async (args) => {
		const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(args.url.trim())?.[1]?.toLowerCase();
		if (!scheme) throw new Error("url needs a scheme, such as https:");
		if (BLOCKED_SCHEMES.has(scheme)) throw new Error(`${scheme}: links are not allowed`);
		await launch(() => Apps.open({ uri: args.url.trim() }));
		return text(`Opened ${args.url}.`);
	},
});

const MAX_SHARE_BYTES = 15 * 1024 * 1024;

const share = defineAppTool({
	name: "share",
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
		await launch(() => Apps.share({ text: args.text, title: args.title, ...file }));
		return text("Opened the share sheet. The user picks where it goes.");
	},
});

export type AppFile = { fileBase64: string; fileName: string; mimeType: string };

export function appFile(fileName: string, bytes: Uint8Array): AppFile {
	return { fileBase64: toBase64(bytes), fileName, mimeType: mimeTypeOf(fileName) ?? "application/octet-stream" };
}

export const AppsExtension = defineExtension({
	name: "phone_apps",
	tools: [setAlarm, setTimer, composeEmail, composeSms, openMaps, openLink, share],
	sections: [
		section("phone_apps", () => "Drafts and shares open a screen the user finishes (never say it was sent); open other apps only when the user asks to go, open, call, or send."),
	],
});
