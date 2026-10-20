// The phone's calendars, within what Settings allows (calendar-access.ts): reading the user's schedule, and adding an
// event to an enabled account after the user approves it. Shared calendars hold other people's events; they are read
// only when turned on and asked for, and never written to.
import { Capacitor, registerPlugin } from "@capacitor/core";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { accountKey, type CalendarAccess, canRead, canWrite } from "../calendar-access.ts";
import { requestConfirmation } from "../confirm.ts";

/** A visible calendar. `own`: its owner is the account it syncs through; otherwise someone shared it with the user. */
export interface PhoneCalendar {
	id: number;
	name: string;
	account: string;
	accountType: string;
	owner: string;
	own: boolean;
	/** Own, and accepts new events. */
	writable: boolean;
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
	accountType: string;
	calendarId: number;
	shared?: boolean;
	owner?: string;
}

interface CalendarPlugin {
	listAccounts(): Promise<{ calendars: PhoneCalendar[] }>;
	listEvents(options: { from: number; to: number; includeShared: boolean }): Promise<{ events: PhoneEvent[] }>;
	insertEvent(options: {
		calendarId: number;
		title: string;
		begin: number;
		end: number;
		allDay: boolean;
		location?: string;
		description?: string;
	}): Promise<{ id: number }>;
	checkPermissions(): Promise<{ calendar: string }>;
}

export const Calendar = registerPlugin<CalendarPlugin>("Calendar");

const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });

function requireNative(): void {
	if (!Capacitor.isNativePlatform()) throw new Error("only available in the Android app");
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const pad = (n: number) => String(n).padStart(2, "0");
const localDate = (ms: number) => {
	const d = new Date(ms);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const localTime = (ms: number) => {
	const d = new Date(ms);
	return `${localDate(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
/** All-day events are stored as UTC days. */
const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Local wall-clock time "YYYY-MM-DDTHH:MM" (or a date) to its parts. */
function parseLocal(value: string, field: string): { y: number; mo: number; d: number; h: number; mi: number; hasTime: boolean } {
	const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(value.trim());
	if (!match) throw new Error(`${field} must be local time as YYYY-MM-DDTHH:MM (or YYYY-MM-DD), got ${JSON.stringify(value)}`);
	const [, y, mo, d, h, mi] = match;
	return { y: Number(y), mo: Number(mo), d: Number(d), h: Number(h ?? 0), mi: Number(mi ?? 0), hasTime: h !== undefined };
}

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
	const sameDay = localDate(times.begin) === localDate(times.end);
	return sameDay
		? `${date(times.begin)} ${time(times.begin)}–${time(times.end)}`
		: `${date(times.begin)} ${time(times.begin)} – ${date(times.end)} ${time(times.end)}`;
}

/** How the account reads to the user: an email for Google, otherwise with the provider's type. */
export function accountLabel(calendar: { account: string; accountType: string }): string {
	if (calendar.accountType === "com.google") return calendar.account;
	if (calendar.accountType === "LOCAL") return "這支手機";
	if (calendar.accountType === "com.osp.app.signin") return `${calendar.account}（Samsung 帳號）`;
	return `${calendar.account}（${calendar.accountType}）`;
}

/** Local "YYYY-MM-DD HH:MM" for the model; all-day events as dates. */
function formatEvent(event: PhoneEvent): Record<string, unknown> {
	return {
		title: event.title,
		...(event.allDay
			? { allDay: true, date: utcDate(event.begin), ...(event.end - event.begin > DAY ? { lastDate: utcDate(event.end - DAY) } : {}) }
			: { start: localTime(event.begin), end: localTime(event.end) }),
		...(event.location ? { location: event.location } : {}),
		...(event.notes ? { notes: event.notes } : {}),
		calendar: event.calendar,
		account: event.account,
		...(event.shared ? { shared: true, owner: event.owner } : {}),
	};
}

/** The calendars events may be added to under `access`, the default first. */
async function writableCalendars(access: CalendarAccess): Promise<PhoneCalendar[]> {
	const { calendars } = await Calendar.listAccounts();
	return calendars
		.filter((calendar) => calendar.writable && canWrite(access, calendar))
		.sort((a, b) => Number(b.id === access.defaultCalendar) - Number(a.id === access.defaultCalendar));
}

const NO_WRITABLE =
	"No calendar is enabled for adding events. Tell the user to open Settings → 行事曆 and turn on 寫入 for the account to use; do not suggest another way to add it.";

export function createCalendarExtension(access: CalendarAccess) {
	const readEvents = defineTool({
		name: "read_calendar_events",
		description:
			"The user's schedule: events on their own calendars (recurring events expanded, declined invitations left out) between two local times, from the accounts Settings allows. Default: from now to the end of tomorrow. Shared calendars they subscribe to, such as a team calendar or a colleague's, hold other people's events: include_shared adds them, marked shared with the owner, if Settings allows it.",
		parameters: Type.Object({
			from: Type.Optional(Type.String({ description: "Local time YYYY-MM-DDTHH:MM or a date YYYY-MM-DD; default now" })),
			to: Type.Optional(Type.String({ description: "Local time or date (a date means the end of that day); default the end of tomorrow" })),
			include_shared: Type.Optional(Type.Boolean({ description: "Also read shared calendars; only when the user asks about them" })),
		}),
		replay: "safe",
		execute: async (args) => {
			requireNative();
			if (args.include_shared && !access.shared)
				throw new Error("Reading shared calendars is turned off in Settings → 行事曆. Tell the user; do not retry.");
			const instant = (value: string, field: string, endOfDay: boolean) => {
				const t = parseLocal(value, field);
				const start = new Date(t.y, t.mo - 1, t.d, t.h, t.mi).getTime();
				return endOfDay && !t.hasTime ? start + DAY : start;
			};
			const from = args.from ? instant(args.from, "from", false) : Date.now();
			const today = new Date();
			today.setHours(0, 0, 0, 0);
			const to = args.to ? instant(args.to, "to", true) : today.getTime() + 2 * DAY;
			if (to <= from) throw new Error("to must be after from");
			// Over a year is almost always a mistake, and the list would not fit.
			if (to - from > 366 * DAY) throw new Error("the range can be at most a year");
			const { events } = await Calendar.listEvents({ from, to, includeShared: args.include_shared ?? false });
			// The local query range catches all-day events of a neighbouring UTC day; keep those whose days overlap.
			const first = localDate(from);
			const last = localDate(to - 1);
			const allowed = events.filter(
				(event) =>
					canRead(access, { ...event, shared: event.shared ?? false }) &&
					(!event.allDay || (utcDate(event.begin) <= last && utcDate(event.end - DAY) >= first)),
			);
			const hidden = access.hidden.length > 0 ? "\n(Accounts the user hid in Settings are left out on purpose. Do not mention it, unless the user asks about an event that could be in one of them.)" : "";
			return text((allowed.length === 0 ? "No events in this range." : JSON.stringify(allowed.map(formatEvent), null, 2)) + hidden);
		},
	});

	const listCalendars = defineTool({
		name: "list_calendars",
		description:
			"The calendars events can be added to: the user's own calendars in the accounts they enabled for writing in Settings, the default first. Call before add_calendar_event when the user names an account or there is no default.",
		parameters: Type.Object({}),
		replay: "safe",
		execute: async () => {
			requireNative();
			const calendars = await writableCalendars(access);
			if (calendars.length === 0) return text(NO_WRITABLE);
			return text(
				JSON.stringify(
					calendars.map(({ id, name, account, accountType }) => ({
						id,
						name,
						account: accountLabel({ account, accountType }),
						...(id === access.defaultCalendar ? { default: true } : {}),
					})),
					null,
					2,
				),
			);
		},
	});

	const addEvent = defineTool({
		name: "add_calendar_event",
		description:
			"Add an event to the user's calendar. Without calendar_id it goes to the default calendar set in Settings. The user approves the account, calendar and details first; nothing is written if they decline.",
		parameters: Type.Object({
			calendar_id: Type.Optional(Type.Integer({ description: "id from list_calendars; omit for the default calendar" })),
			title: Type.String(),
			start: Type.String({ description: "Local time YYYY-MM-DDTHH:MM, or YYYY-MM-DD with all_day" }),
			end: Type.Optional(
				Type.String({ description: "Local time YYYY-MM-DDTHH:MM (or the last day, with all_day); default one hour after start" }),
			),
			all_day: Type.Optional(Type.Boolean()),
			location: Type.Optional(Type.String()),
			notes: Type.Optional(Type.String()),
		}),
		execute: async (args) => {
			requireNative();
			const allDay = args.all_day ?? false;
			const times = eventTimes(args.start, args.end, allDay);
			const calendars = await writableCalendars(access);
			if (calendars.length === 0) throw new Error(NO_WRITABLE);
			const id = args.calendar_id ?? access.defaultCalendar;
			if (id === undefined) {
				throw new Error(
					`No default calendar is set. Ask the user which of these to use, then pass calendar_id: ${calendars.map((c) => `${c.id} ${c.name} (${accountLabel(c)})`).join("; ")}`,
				);
			}
			const calendar = calendars.find((candidate) => candidate.id === id);
			if (!calendar) throw new Error(`calendar ${id} is not enabled for writing in Settings; call list_calendars`);
			const approved = await requestConfirmation({
				title: `加到 ${accountLabel(calendar)} 的「${calendar.name}」行事曆`,
				detail: [args.title, describeTimes(times, allDay), args.location, args.notes].filter(Boolean).join("\n"),
			});
			if (!approved) throw new Error("The user declined adding this event. Reply with one short sentence that nothing was done, such as 「好，沒有加。」; do not list what it would have been, offer alternatives, or ask why.");
			const created = await Calendar.insertEvent({
				calendarId: calendar.id,
				title: args.title,
				...times,
				allDay,
				location: args.location,
				description: args.notes,
			});
			return text(`Added event ${created.id} to "${calendar.name}" (${calendar.account}): ${describeTimes(times, allDay)}.`);
		},
	});

	return defineExtension({
		name: "calendar",
		tools: [readEvents, listCalendars, addEvent],
		sections: [
			section("calendar", () =>
				[
					"read_calendar_events shows the user's schedule from their own calendars. Events marked shared are someone else's (a team or colleague calendar): never present them as the user's plans. For whether they can make an event, get the travel time from their position with get_travel_time, say when to leave, and offer open_maps.",
					"Adding events: the user chose in Settings which accounts may be written and a default calendar. Use the default unless the user names another account. If there is no default and several calendars are enabled, ask which, naming the accounts; never guess between work and personal from the event's content.",
				].join("\n"),
			),
		],
	});
}

/** Own calendars grouped by account, for Settings. */
export function groupByAccount(calendars: PhoneCalendar[]): { key: string; label: string; calendars: PhoneCalendar[] }[] {
	const groups = new Map<string, { key: string; label: string; calendars: PhoneCalendar[] }>();
	for (const calendar of calendars) {
		if (!calendar.own) continue;
		const key = accountKey(calendar);
		// Local calendars are each their own "account" with an internal name; show the calendar's name instead.
		const label = calendar.accountType === "LOCAL" ? `${calendar.name}（只在這支手機上）` : accountLabel(calendar);
		const group = groups.get(key) ?? { key, label, calendars: [] };
		group.calendars.push(calendar);
		groups.set(key, group);
	}
	return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}
