import { Calendar, type PhoneCalendar, type PhoneEvent } from "../../plugins/calendar.ts";
import { Type } from "typebox";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { accountLabel, type CalendarAccess, canRead, canWrite } from "../calendar-access.ts";
import { DAY, defineAppTool, HOUR, json, localDate, localTime, parseLocalBound, parseLocalTime, startOfToday, text } from "./common.ts";

const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const startOf = (event: PhoneEvent) => (event.allDay ? utcDate(event.begin) : localTime(event.begin));

function utcDay(ms: number): number {
	const date = new Date(ms);
	return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

function eventTimes(start: string, end: string | undefined, allDay: boolean): { begin: number; end: number } {
	const from = parseLocalTime(start, "start");
	const to = end ? parseLocalTime(end, "end") : undefined;
	if (allDay) {
		const begin = utcDay(from.ms);
		const last = to ? utcDay(to.ms) : begin;
		if (last < begin) throw new Error("end is before start");
		return { begin, end: last + DAY };
	}
	if (!from.hasTime) throw new Error("start needs a time (YYYY-MM-DD HH:MM) unless all_day is true");
	const finish = to ? to.ms : from.ms + HOUR;
	if (finish < from.ms) throw new Error("end is before start");
	return { begin: from.ms, end: finish };
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

function formatEvent(event: PhoneEvent) {
	return {
		id: event.id,
		title: event.title,
		...(event.allDay
			? { allDay: true as const, date: utcDate(event.begin), ...(event.end - event.begin > DAY ? { lastDate: utcDate(event.end - DAY) } : {}) }
			: { start: localTime(event.begin), end: localTime(event.end) }),
		...(event.location ? { location: event.location } : {}),
		...(event.notes ? { notes: event.notes } : {}),
		calendar: event.calendar,
		account: event.account,
		...(event.shared ? { shared: true as const, ...(event.owner ? { owner: event.owner } : {}) } : {}),
	};
}

async function writableCalendars(access: CalendarAccess): Promise<PhoneCalendar[]> {
	const { calendars } = await Calendar.listAccounts();
	return calendars
		.filter((calendar) => calendar.writable && canWrite(access, calendar))
		.sort((a, b) => Number(b.id === access.defaultCalendar) - Number(a.id === access.defaultCalendar));
}

const NO_WRITABLE =
	"No calendar is enabled for adding events. Tell the user to open Settings → 行事曆 and turn on 寫入 for the account to use; do not suggest another way to add it.";

export function createCalendarExtension(access: CalendarAccess) {
	const readEvents = defineAppTool({
		name: "read_calendar_events",
		effect: "read",
		needs: [Calendar.listEvents],
		description:
			"The user's schedule: events on their own calendars (recurring events expanded, declined invitations left out) between two local times, from the accounts Settings allows. Default: from now to the end of tomorrow. Shared calendars they subscribe to, such as a team calendar or a colleague's, hold other people's events: include_shared adds them, marked shared with the owner, if Settings allows it.",
		parameters: Type.Object({
			from: Type.Optional(Type.String({ description: "Local time YYYY-MM-DD HH:MM or a date YYYY-MM-DD; default now" })),
			to: Type.Optional(Type.String({ description: "Local time or date (a date means the end of that day); default the end of tomorrow" })),
			include_shared: Type.Optional(Type.Boolean({ description: "Also read shared calendars; only when the user asks about them" })),
		}),
		structuredOutputSchema: Type.Object({
			events: Type.Array(
				Type.Object({
					id: Type.String({ description: "Pass to delete_calendar_event with start" }),
					title: Type.String(),
					all_day: Type.Boolean(),
					start: Type.String({ description: "Local time YYYY-MM-DD HH:MM, or the date of an all-day event" }),
					end: Type.String({ description: "Local time YYYY-MM-DD HH:MM, or the last date of an all-day event" }),
					location: Type.Optional(Type.String()),
					notes: Type.Optional(Type.String()),
					calendar: Type.String(),
					account: Type.String(),
					shared: Type.Boolean({ description: "Someone else's calendar the user subscribes to" }),
				}),
			),
		}),
		replay: "safe",
		execute: async (args) => {
			if (args.include_shared && !access.shared)
				throw new Error("Reading shared calendars is turned off in Settings → 行事曆. Tell the user; do not retry.");
			const from = args.from ? parseLocalBound(args.from, "from", false) : Date.now();
			const to = args.to ? parseLocalBound(args.to, "to", true) : startOfToday() + 2 * DAY;
			if (to <= from) throw new Error("to must be after from");
			if (to - from > 366 * DAY) throw new Error("the range can be at most a year");
			const { events } = await Calendar.listEvents({ from, to, includeShared: args.include_shared ?? false });
			const first = localDate(from);
			const last = localDate(to - 1);
			const allowed = events.filter(
				(event) =>
					canRead(access, { ...event, shared: event.shared ?? false }) &&
					(!event.allDay || (utcDate(event.begin) <= last && utcDate(event.end - DAY) >= first)),
			);
			const hidden = access.hidden.length > 0 ? "\n(Accounts the user hid in Settings are left out on purpose. Do not mention it, unless the user asks about an event that could be in one of them.)" : "";
			const structuredOutput = {
				events: allowed.map((event) => ({
					id: event.id,
					title: event.title,
					all_day: event.allDay,
					start: startOf(event),
					end: event.allDay ? utcDate(event.end - DAY) : localTime(event.end),
					...(event.location ? { location: event.location } : {}),
					...(event.notes ? { notes: event.notes } : {}),
					calendar: event.calendar,
					account: event.account,
					shared: event.shared ?? false,
				})),
			};
			return { ...text((allowed.length === 0 ? "No events in this range." : JSON.stringify(allowed.map(formatEvent), null, 2)) + hidden), structuredOutput };
		},
	});

	const listCalendars = defineAppTool({
		name: "list_calendars",
		effect: "read",
		needs: [Calendar.listAccounts],
		description:
			"The calendars events can be added to: the user's own calendars in the accounts they enabled for writing in Settings, the default first. Call before add_calendar_event when the user names an account or there is no default.",
		parameters: Type.Object({}),
		replay: "safe",
		execute: async () => {
			const calendars = await writableCalendars(access);
			if (calendars.length === 0) return text(NO_WRITABLE);
			return json(
				calendars.map(({ id, name, account, accountType }) => ({
					id,
					name,
					account: accountLabel({ account, accountType }),
					...(id === access.defaultCalendar ? { default: true } : {}),
				})),
			);
		},
	});

	const addEvent = defineAppTool({
		name: "add_calendar_event",
		effect: "direct",
		needs: [Calendar.listAccounts, Calendar.insertEvent],
		description:
			"Add an event to the user's calendar. Without calendar_id it goes to the default calendar set in Settings.",
		parameters: Type.Object({
			calendar_id: Type.Optional(Type.Integer({ minimum: 1, description: "id from list_calendars; omit for the default calendar" })),
			title: Type.String({ description: "The event's name, as the user would write it" }),
			start: Type.String({ description: "Local time YYYY-MM-DD HH:MM, or YYYY-MM-DD with all_day" }),
			end: Type.Optional(
				Type.String({ description: "Local time YYYY-MM-DD HH:MM (or the last day, with all_day); default one hour after start" }),
			),
			all_day: Type.Optional(Type.Boolean({ description: "Whole days, without times" })),
			location: Type.Optional(Type.String({ description: "Where; an address or place name" })),
			notes: Type.Optional(Type.String({ description: "Anything else to remember" })),
		}),
		execute: async (args) => {
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

	const deleteEvent = defineAppTool({
		name: "delete_calendar_event",
		effect: "direct",
		needs: [Calendar.listEvents, Calendar.listAccounts, Calendar.deleteEvent],
		description:
			"Delete an event from the user's calendar. Of a repeating event only the occurrence at start goes, unless the user asks to delete the whole series.",
		parameters: Type.Object({
			id: Type.String({ description: "The event's id from read_calendar_events, or from add_calendar_event" }),
			start: Type.String({ description: "The occurrence's start as read_calendar_events gives it: local time YYYY-MM-DD HH:MM, or the date of an all-day event" }),
			all_occurrences: Type.Optional(Type.Boolean({ description: "Delete every occurrence of a repeating event; only when the user asks for the whole series" })),
		}),
		execute: async (args) => {
			const at = parseLocalTime(args.start, "start");
			const wanted = at.hasTime ? localTime(at.ms) : localDate(at.ms);
			const { events } = await Calendar.listEvents({ from: at.ms - DAY, to: at.ms + DAY, includeShared: false });
			const event = events.find((candidate) => candidate.id === args.id && startOf(candidate) === wanted);
			if (!event) throw new Error(`No event ${args.id} starts at ${args.start}; read_calendar_events gives each event's id and start.`);
			const calendars = await writableCalendars(access);
			if (!calendars.some((calendar) => calendar.id === event.calendarId))
				throw new Error(`"${event.calendar}" (${event.account}) is not enabled for writing in Settings → 行事曆. Tell the user; do not retry.`);
			const all = args.all_occurrences ?? false;
			const { repeating } = await Calendar.deleteEvent({ id: event.id, begin: event.begin, all });
			const when = describeTimes(event, event.allDay);
			if (!repeating) return text(`Deleted "${event.title}" (${when}) from "${event.calendar}".`);
			if (all) return text(`Deleted "${event.title}" from "${event.calendar}", every occurrence.`);
			return text(`Deleted the ${when} occurrence of "${event.title}"; its other occurrences stay.`);
		},
	});

	return defineExtension({
		name: "calendar",
		tools: [readEvents, listCalendars, addEvent, deleteEvent],
		sections: [
			section("calendar", () => "Shared events are other people's, not the user's plans. Add to the default calendar; with none and several enabled, ask which account."),
		],
	});
}
