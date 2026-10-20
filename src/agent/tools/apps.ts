// Tools that hand work to other apps on the phone through Android intents. Most open a prefilled screen and the user
// finishes there (save the event, press send, pick a share target), so they need no approval of their own.
import { App } from "@capacitor/app";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";

interface AppsPlugin {
	setAlarm(options: { hour: number; minute: number; label?: string; days?: number[] }): Promise<void>;
	setTimer(options: { seconds: number; label?: string }): Promise<void>;
	insertEvent(options: { title: string; begin: number; end?: number; allDay: boolean; location?: string; description?: string }): Promise<void>;
	composeEmail(options: { to: string[]; subject?: string; body: string }): Promise<void>;
	composeSms(options: { to: string; body: string }): Promise<void>;
	open(options: { uri: string }): Promise<void>;
	share(options: { text?: string; title?: string; fileBase64?: string; fileName?: string; mimeType?: string }): Promise<void>;
}

const Apps = registerPlugin<AppsPlugin>("Apps");

/** Android blocks activity starts from the background; fail clearly instead of silently doing nothing. */
async function launch(action: () => Promise<void>): Promise<void> {
	if (!Capacitor.isNativePlatform()) throw new Error("only available in the Android app");
	if (!(await App.getState()).isActive)
		throw new Error("pi is in the background, and Android does not let it open other apps from there. Ask the user to open pi and try again.");
	await action();
}

const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** Local wall-clock time "YYYY-MM-DDTHH:MM" (or a date for all-day) to epoch milliseconds. */
function localTime(value: string, field: string): number {
	const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(value.trim());
	if (!match) throw new Error(`${field} must be local time as YYYY-MM-DDTHH:MM (or YYYY-MM-DD), got ${JSON.stringify(value)}`);
	const [, y, mo, d, h = "0", mi = "0"] = match;
	const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
	if (Number.isNaN(date.getTime())) throw new Error(`${field} is not a real date: ${value}`);
	return date.getTime();
}

const setAlarm = defineTool({
	name: "set_alarm",
	description: "Set an alarm in the phone's clock app, without opening it. Time is the phone's local time.",
	parameters: Type.Object({
		time: Type.String({ description: "24-hour local time, HH:MM" }),
		label: Type.Optional(Type.String()),
		repeat: Type.Optional(Type.Array(Type.Union(WEEKDAYS.map((day) => Type.Literal(day))), { description: "Weekdays to repeat on; omit for once" })),
	}),
	execute: async (args) => {
		const match = /^(\d{1,2}):(\d{2})$/.exec(args.time.trim());
		const hour = match ? Number(match[1]) : NaN;
		const minute = match ? Number(match[2]) : NaN;
		if (!(hour >= 0 && hour < 24 && minute >= 0 && minute < 60)) throw new Error(`time must be HH:MM, got ${args.time}`);
		// Android's EXTRA_DAYS uses java.util.Calendar's numbering: Sunday is 1.
		const days = args.repeat?.map((day) => WEEKDAYS.indexOf(day) + 1);
		await launch(() => Apps.setAlarm({ hour, minute, label: args.label, days }));
		return text(`Alarm set for ${args.time}${days ? ` repeating ${args.repeat?.join(", ")}` : ""}.`);
	},
});

const setTimer = defineTool({
	name: "set_timer",
	description: "Start a countdown timer in the phone's clock app, without opening it.",
	parameters: Type.Object({
		seconds: Type.Integer({ minimum: 1, maximum: 86_400 }),
		label: Type.Optional(Type.String()),
	}),
	execute: async (args) => {
		await launch(() => Apps.setTimer({ seconds: args.seconds, label: args.label }));
		return text(`Timer started for ${args.seconds} seconds.`);
	},
});

const addEvent = defineTool({
	name: "add_calendar_event",
	description:
		"Open the phone's calendar app on a new event with these fields filled in. The user reviews it and taps Save; nothing is created until then.",
	parameters: Type.Object({
		title: Type.String(),
		start: Type.String({ description: "Local time YYYY-MM-DDTHH:MM, or YYYY-MM-DD with all_day" }),
		end: Type.Optional(Type.String({ description: "Local time YYYY-MM-DDTHH:MM; default one hour after start" })),
		all_day: Type.Optional(Type.Boolean()),
		location: Type.Optional(Type.String()),
		notes: Type.Optional(Type.String()),
	}),
	execute: async (args) => {
		const begin = localTime(args.start, "start");
		const end = args.end ? localTime(args.end, "end") : undefined;
		if (end !== undefined && end < begin) throw new Error("end is before start");
		await launch(() =>
			Apps.insertEvent({ title: args.title, begin, end, allDay: args.all_day ?? false, location: args.location, description: args.notes }),
		);
		return text("Opened the calendar with the event filled in. It is created only when the user taps Save.");
	},
});

const composeEmail = defineTool({
	name: "compose_email",
	description: "Open the phone's email app on a draft. The user reviews it and sends it; nothing is sent by this tool.",
	parameters: Type.Object({
		to: Type.Optional(Type.Array(Type.String())),
		subject: Type.Optional(Type.String()),
		body: Type.String(),
	}),
	execute: async (args) => {
		await launch(() => Apps.composeEmail({ to: args.to ?? [], subject: args.subject, body: args.body }));
		return text("Opened an email draft. It is sent only if the user presses send.");
	},
});

const composeSms = defineTool({
	name: "compose_sms",
	description: "Open the phone's messaging app on a text message draft. The user sends it; nothing is sent by this tool.",
	parameters: Type.Object({
		to: Type.Optional(Type.String({ description: "Phone number" })),
		body: Type.String(),
	}),
	execute: async (args) => {
		await launch(() => Apps.composeSms({ to: args.to ?? "", body: args.body }));
		return text("Opened a message draft. It is sent only if the user presses send.");
	},
});

const TRAVEL_MODES = ["driving", "walking", "transit", "bicycling"] as const;

const openMaps = defineTool({
	name: "open_maps",
	description: "Open directions to a place in Google Maps (or the phone's maps app). The user starts navigation there.",
	parameters: Type.Object({
		destination: Type.String({ description: "Address, place name, or lat,lng" }),
		origin: Type.Optional(Type.String({ description: "Default: current location" })),
		mode: Type.Optional(Type.Union(TRAVEL_MODES.map((mode) => Type.Literal(mode)))),
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
const BLOCKED_SCHEMES = new Set(["intent", "file", "content", "javascript", "data", "about", "blob", "android-app"]);

const openLink = defineTool({
	name: "open_link",
	description:
		"Open a URL or an app deep link (for example https://…, geo:, tel: which opens the dialer without calling, market://, spotify:…) in the app that handles it.",
	parameters: Type.Object({ url: Type.String() }),
	execute: async (args) => {
		const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(args.url.trim())?.[1]?.toLowerCase();
		if (!scheme) throw new Error("url needs a scheme, such as https:");
		if (BLOCKED_SCHEMES.has(scheme)) throw new Error(`${scheme}: links are not allowed`);
		await launch(() => Apps.open({ uri: args.url.trim() }));
		return text(`Opened ${args.url}.`);
	},
});

const MAX_SHARE_BYTES = 15 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
	png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
	pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
	html: "text/html", zip: "application/zip", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", mp4: "video/mp4",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function base64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

const share = defineTool({
	name: "share",
	description:
		"Open the Android share sheet with text and/or one file from the sandbox, so the user can send it to another app (LINE, Drive, email…). The user picks the target.",
	parameters: Type.Object({
		text: Type.Optional(Type.String()),
		sandbox_path: Type.Optional(Type.String({ description: "File in the sandbox to share, e.g. /workspace/chart.png" })),
		title: Type.Optional(Type.String()),
	}),
	execute: async (args, api, context) => {
		if (!args.text && !args.sandbox_path) throw new Error("give text, sandbox_path, or both");
		let file: { fileBase64: string; fileName: string; mimeType: string } | undefined;
		if (args.sandbox_path) {
			if (!api.env) throw new Error("no sandbox is configured");
			const read = await api.env.readBinaryFile(args.sandbox_path, context);
			if (!read.ok) throw new Error(`cannot read ${args.sandbox_path}: ${read.error.message}`);
			if (read.value.byteLength > MAX_SHARE_BYTES) throw new Error(`file is larger than ${MAX_SHARE_BYTES / 1024 / 1024} MB`);
			const fileName = args.sandbox_path.split("/").pop() || "file";
			const extension = fileName.includes(".") ? fileName.split(".").pop()?.toLowerCase() : undefined;
			file = { fileBase64: base64(read.value), fileName, mimeType: (extension && MIME_TYPES[extension]) || "application/octet-stream" };
		}
		await launch(() => Apps.share({ text: args.text, title: args.title, ...file }));
		return text("Opened the share sheet. The user picks where it goes.");
	},
});

export const AppsExtension = defineExtension({
	name: "phone_apps",
	tools: [setAlarm, setTimer, addEvent, composeEmail, composeSms, openMaps, openLink, share],
	sections: [
		section("phone_apps", () =>
			[
				"You can hand things to other apps on this phone: alarms and timers, calendar events, email and text drafts, map directions, links and app deep links, and the share sheet (also for sandbox files).",
				"Except alarms and timers, these open a prefilled screen; the user finishes there. Say what they need to tap, and never claim an event was saved or a message was sent.",
			].join("\n"),
		),
	],
});
