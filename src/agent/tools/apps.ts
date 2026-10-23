// Tools that hand work to other apps on the phone through Android intents. Most open a prefilled screen and the user
// finishes there (press send, pick a share target), so pi does not send anything itself. Calendars are in calendar.ts.
import { App } from "@capacitor/app";
import { registerPlugin } from "@capacitor/core";
import { Type } from "typebox";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { defineAppTool, parseClock, requireNative, text } from "./common.ts";

interface AppsPlugin {
	setAlarm(options: { hour: number; minute: number; label?: string; days?: number[] }): Promise<void>;
	setTimer(options: { seconds: number; label?: string }): Promise<void>;
	composeEmail(options: { to: string[]; subject?: string; body: string }): Promise<void>;
	composeSms(options: { to: string; body: string }): Promise<void>;
	open(options: { uri: string }): Promise<void>;
	share(options: { text?: string; title?: string; fileBase64?: string; fileName?: string; mimeType?: string }): Promise<void>;
	/** Open a file in the app that views its type; rejects with code "NO_APP" when there is none. */
	openFile(options: { fileBase64: string; fileName: string; mimeType: string }): Promise<void>;
}

export const Apps = registerPlugin<AppsPlugin>("Apps");

/** Android blocks activity starts from the background; fail clearly instead of silently doing nothing. */
async function launch(action: () => Promise<void>): Promise<void> {
	requireNative();
	if (!(await App.getState()).isActive)
		throw new Error("pi is in the background, and Android does not let it open other apps from there. Ask the user to open pi and try again.");
	await action();
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

const setAlarm = defineAppTool({
	name: "set_alarm",
	description: "Set an alarm in the phone's clock app, without opening it. Time is the phone's local time.",
	parameters: Type.Object({
		time: Type.String({ description: "24-hour local time, HH:MM" }),
		label: Type.Optional(Type.String({ description: "Shown when it rings" })),
		repeat: Type.Optional(Type.Array(Type.Union(WEEKDAYS.map((day) => Type.Literal(day))), { description: "Weekdays to repeat on; omit for once" })),
	}),
	execute: async (args) => {
		const { hour, minute } = parseClock(args.time, "time");
		// Android's EXTRA_DAYS uses java.util.Calendar's numbering: Sunday is 1.
		const days = args.repeat?.map((day) => WEEKDAYS.indexOf(day) + 1);
		await launch(() => Apps.setAlarm({ hour, minute, label: args.label, days }));
		return text(`Alarm set for ${args.time}${days ? ` repeating ${args.repeat?.join(", ")}` : ""}.`);
	},
});

const setTimer = defineAppTool({
	name: "set_timer",
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
	description: "Open directions to a place in Google Maps (or the phone's maps app). The user starts navigation there.",
	parameters: Type.Object({
		destination: Type.String({ description: "Address, place name, or lat,lng" }),
		origin: Type.Optional(Type.String({ description: "Default: current location" })),
		mode: Type.Optional(Type.Union(TRAVEL_MODES.map((mode) => Type.Literal(mode)), { description: "How the user goes; default the maps app's" })),
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

/** Schemes that reach into the app itself or the file system rather than another app. */
const BLOCKED_SCHEMES = new Set(["intent", "file", "content", "javascript", "data", "about", "blob", "android-app", "pimobile", "dev.geminixiang.pimobile"]);

const openLink = defineAppTool({
	name: "open_link",
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

export const MIME_TYPES: Record<string, string> = {
	png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
	pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
	html: "text/html", zip: "application/zip", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", mp4: "video/mp4",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function base64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

const share = defineAppTool({
	name: "share",
	description:
		"Open the Android share sheet with text and/or one file from your folder (on the phone, or in the sandbox when there is one), so the user can send it to another app (LINE, Drive, email…). The user picks the target.",
	parameters: Type.Object({
		text: Type.Optional(Type.String({ description: "Text to share" })),
		path: Type.Optional(Type.String({ description: "File in your folder to share, as read takes it, e.g. report.csv" })),
		title: Type.Optional(Type.String({ description: "Title of the share sheet" })),
	}),
	execute: async (args, api, context) => {
		if (!args.text && !args.path) throw new Error("give text, path, or both");
		let file: { fileBase64: string; fileName: string; mimeType: string } | undefined;
		if (args.path) {
			if (!api.env) throw new Error("this bot has no folder");
			const absolute = await api.env.absolutePath(args.path, context);
			if (!absolute.ok) throw new Error(`cannot read ${args.path}: ${absolute.error.message}`);
			const read = await api.env.readBinaryFile(absolute.value, context);
			if (!read.ok) throw new Error(`cannot read ${args.path}: ${read.error.message}`);
			if (read.value.byteLength > MAX_SHARE_BYTES) throw new Error(`file is larger than ${MAX_SHARE_BYTES / 1024 / 1024} MB`);
			const fileName = absolute.value.split("/").pop() || "file";
			const extension = fileName.includes(".") ? fileName.split(".").pop()?.toLowerCase() : undefined;
			file = { fileBase64: base64(read.value), fileName, mimeType: (extension && MIME_TYPES[extension]) || "application/octet-stream" };
		}
		await launch(() => Apps.share({ text: args.text, title: args.title, ...file }));
		return text("Opened the share sheet. The user picks where it goes.");
	},
});

export const AppsExtension = defineExtension({
	name: "phone_apps",
	tools: [setAlarm, setTimer, composeEmail, composeSms, openMaps, openLink, share],
	sections: [
		section("phone_apps", () => "Drafts and shares open a screen the user finishes (never say it was sent); open other apps only when the user asks to go, open, call, or send."),
	],
});
