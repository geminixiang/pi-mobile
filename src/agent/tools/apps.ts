// Tools that hand work to other apps on the phone through Android intents. Most open a prefilled screen and the user
// finishes there (press send, pick a share target), so they need no approval of their own. Calendar events are the
// exception: they are written to a calendar the agent names, after the user approves the account and the details.
import { App } from "@capacitor/app";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { requestConfirmation } from "../confirm.ts";

interface AppsPlugin {
	setAlarm(options: { hour: number; minute: number; label?: string; days?: number[] }): Promise<void>;
	setTimer(options: { seconds: number; label?: string }): Promise<void>;
	composeEmail(options: { to: string[]; subject?: string; body: string }): Promise<void>;
	composeSms(options: { to: string; body: string }): Promise<void>;
	open(options: { uri: string }): Promise<void>;
	share(options: { text?: string; title?: string; fileBase64?: string; fileName?: string; mimeType?: string }): Promise<void>;
}

const Apps = registerPlugin<AppsPlugin>("Apps");

interface PhoneCalendar {
	id: number;
	name: string;
	account: string;
	accountType: string;
	primary: boolean;
}

interface PhoneEvent {
	title: string;
	begin: number;
	end: number;
	allDay: boolean;
	location?: string;
	notes?: string;
	calendar: string;
	account: string;
	calendarId: number;
}

interface CalendarPlugin {
	listCalendars(): Promise<{ calendars: PhoneCalendar[] }>;
	listEvents(options: { from: number; to: number }): Promise<{ events: PhoneEvent[] }>;
	insertEvent(options: {
		calendarId: number;
		title: string;
		begin: number;
		end: number;
		allDay: boolean;
		location?: string;
		description?: string;
	}): Promise<{ id: number }>;
}

const Calendar = registerPlugin<CalendarPlugin>("Calendar");

/** Android blocks activity starts from the background; fail clearly instead of silently doing nothing. */
async function launch(action: () => Promise<void>): Promise<void> {
	if (!Capacitor.isNativePlatform()) throw new Error("only available in the Android app");
	if (!(await App.getState()).isActive)
		throw new Error("pi is in the background, and Android does not let it open other apps from there. Ask the user to open pi and try again.");
	await action();
}

const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** Local wall-clock time "YYYY-MM-DDTHH:MM" (or a date) to its parts. */
function parseLocal(value: string, field: string): { y: number; mo: number; d: number; h: number; mi: number; hasTime: boolean } {
	const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(value.trim());
	if (!match) throw new Error(`${field} must be local time as YYYY-MM-DDTHH:MM (or YYYY-MM-DD), got ${JSON.stringify(value)}`);
	const [, y, mo, d, h, mi] = match;
	return { y: Number(y), mo: Number(mo), d: Number(d), h: Number(h ?? 0), mi: Number(mi ?? 0), hasTime: h !== undefined };
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Event times for the calendar provider: local instants, or UTC midnights for all-day events (end exclusive). */
function eventTimes(start: string, end: string | undefined, allDay: boolean): { begin: number; end: number } {
	const from = parseLocal(start, "start");
	const to = end ? parseLocal(end, "end") : undefined;
	if (allDay) {
		const begin = Date.UTC(from.y, from.mo - 1, from.d);
		const last = to ? Date.UTC(to.y, to.mo - 1, to.d) : begin;
		if (last < begin) throw new Error("end is before start");
		return { begin, end: last + DAY };
	}
	if (!from.hasTime) throw new Error("start needs a time (YYYY-MM-DDTHH:MM) unless all_day is true");
	const begin = new Date(from.y, from.mo - 1, from.d, from.h, from.mi).getTime();
	const finish = to ? new Date(to.y, to.mo - 1, to.d, to.h, to.mi).getTime() : begin + HOUR;
	if (Number.isNaN(begin) || Number.isNaN(finish)) throw new Error("not a real date");
	if (finish < begin) throw new Error("end is before start");
	return { begin, end: finish };
}

function describeTimes(times: { begin: number; end: number }, allDay: boolean): string {
	const date = (ms: number, timeZone?: string) =>
		new Date(ms).toLocaleDateString("zh-TW", { timeZone, month: "numeric", day: "numeric", weekday: "short" });
	const time = (ms: number) => new Date(ms).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false });
	if (allDay) {
		const first = date(times.begin, "UTC");
		const last = date(times.end - DAY, "UTC");
		return first === last ? `${first} 整天` : `${first} – ${last} 整天`;
	}
	const sameDay = new Date(times.begin).toDateString() === new Date(times.end).toDateString();
	return sameDay
		? `${date(times.begin)} ${time(times.begin)}–${time(times.end)}`
		: `${date(times.begin)} ${time(times.begin)} – ${date(times.end)} ${time(times.end)}`;
}

/** How the account reads in the approval: an email for Google, otherwise the provider's own name. */
function accountLabel(calendar: PhoneCalendar): string {
	return calendar.accountType === "com.google" ? calendar.account : `${calendar.account}（${calendar.accountType}）`;
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

const listCalendars = defineTool({
	name: "list_calendars",
	description:
		"List the calendars on this phone that events can be added to, with the account each belongs to (often both a work and a personal Google account). Call before add_calendar_event.",
	parameters: Type.Object({}),
	execute: async () => {
		if (!Capacitor.isNativePlatform()) throw new Error("only available in the Android app");
		const { calendars } = await Calendar.listCalendars();
		if (calendars.length === 0) return text("No writable calendars on this phone.");
		return text(JSON.stringify(calendars.map(({ id, name, account, accountType, primary }) => ({ id, name, account, accountType, primary })), null, 2));
	},
});

/** Local "YYYY-MM-DD HH:MM" for the model; all-day events are stored at UTC midnight, so they read as dates in UTC. */
function formatEvent(event: PhoneEvent): Record<string, unknown> {
	const pad = (n: number) => String(n).padStart(2, "0");
	const local = (ms: number) => {
		const d = new Date(ms);
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
	};
	const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
	return {
		title: event.title,
		...(event.allDay
			? { allDay: true, date: utcDate(event.begin), ...(event.end - event.begin > DAY ? { lastDate: utcDate(event.end - DAY) } : {}) }
			: { start: local(event.begin), end: local(event.end) }),
		...(event.location ? { location: event.location } : {}),
		...(event.notes ? { notes: event.notes } : {}),
		calendar: event.calendar,
		account: event.account,
	};
}

const readEvents = defineTool({
	name: "read_calendar_events",
	description:
		"Events on the phone's calendars (all accounts, recurring events expanded, declined invitations left out) between two local times. Default: from now to the end of tomorrow.",
	parameters: Type.Object({
		from: Type.Optional(Type.String({ description: "Local time YYYY-MM-DDTHH:MM or a date YYYY-MM-DD; default now" })),
		to: Type.Optional(Type.String({ description: "Local time or date (a date means the end of that day); default the end of tomorrow" })),
	}),
	replay: "safe",
	execute: async (args) => {
		if (!Capacitor.isNativePlatform()) throw new Error("only available in the Android app");
		const instant = (value: string, field: string, endOfDay: boolean) => {
			const t = parseLocal(value, field);
			const start = new Date(t.y, t.mo - 1, t.d, t.h, t.mi).getTime();
			return endOfDay && !t.hasTime ? start + DAY : start;
		};
		const from = args.from ? instant(args.from, "from", false) : Date.now();
		const tomorrow = new Date();
		tomorrow.setHours(0, 0, 0, 0);
		const to = args.to ? instant(args.to, "to", true) : tomorrow.getTime() + 2 * DAY;
		if (to <= from) throw new Error("to must be after from");
		// Over a year is almost always a mistake, and the list would not fit.
		if (to - from > 366 * DAY) throw new Error("the range can be at most a year");
		const { events } = await Calendar.listEvents({ from, to });
		return text(events.length === 0 ? "No events in this range." : JSON.stringify(events.map(formatEvent), null, 2));
	},
});

const addEvent = defineTool({
	name: "add_calendar_event",
	description:
		"Add an event to one calendar from list_calendars. The user approves the account, calendar and details first; nothing is written if they decline.",
	parameters: Type.Object({
		calendar_id: Type.Integer({ description: "id from list_calendars" }),
		title: Type.String(),
		start: Type.String({ description: "Local time YYYY-MM-DDTHH:MM, or YYYY-MM-DD with all_day" }),
		end: Type.Optional(Type.String({ description: "Local time YYYY-MM-DDTHH:MM (or the last day, with all_day); default one hour after start" })),
		all_day: Type.Optional(Type.Boolean()),
		location: Type.Optional(Type.String()),
		notes: Type.Optional(Type.String()),
	}),
	execute: async (args) => {
		if (!Capacitor.isNativePlatform()) throw new Error("only available in the Android app");
		const allDay = args.all_day ?? false;
		const times = eventTimes(args.start, args.end, allDay);
		const calendar = (await Calendar.listCalendars()).calendars.find((candidate) => candidate.id === args.calendar_id);
		if (!calendar) throw new Error(`no writable calendar with id ${args.calendar_id}; call list_calendars`);
		const approved = await requestConfirmation({
			title: `加到 ${accountLabel(calendar)} 的「${calendar.name}」行事曆`,
			detail: [args.title, describeTimes(times, allDay), args.location, args.notes].filter(Boolean).join("\n"),
		});
		if (!approved) throw new Error("The user declined adding this event.");
		const { id } = await Calendar.insertEvent({
			calendarId: calendar.id,
			title: args.title,
			...times,
			allDay,
			location: args.location,
			description: args.notes,
		});
		return text(`Added event ${id} to "${calendar.name}" (${calendar.account}): ${describeTimes(times, allDay)}.`);
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
	tools: [setAlarm, setTimer, readEvents, listCalendars, addEvent, composeEmail, composeSms, openMaps, openLink, share],
	sections: [
		section("phone_apps", () =>
			[
				"You can hand things to other apps on this phone: alarms and timers, calendar events, email and text drafts, map directions, links and app deep links, and the share sheet (also for sandbox files).",
				"Drafts, maps, links and sharing open a prefilled screen; the user finishes there. Say what they need to tap, and never claim a message was sent.",
				"read_calendar_events shows the user's schedule. For questions like whether they can make the next event, combine it with get_location: get the travel time from their position to the event's location with get_travel_time, say when to leave, and offer open_maps.",
				"Adding to the calendar: call list_calendars first. Phones often mix work and personal accounts, and an event in the wrong one is embarrassing. If the writable calendars span more than one account and the user has not said which, ask them, naming the accounts; do not guess from the event's content. Use the account they chose earlier in this conversation without asking again.",
			].join("\n"),
		),
	],
});
