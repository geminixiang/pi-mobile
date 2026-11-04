import assert from "node:assert/strict";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { CalendarAccess } from "../../src/agent/calendar-access.ts";
import { type CalendarStore, createCalendarExtension } from "../../src/agent/tools/calendar.ts";
import { localTime } from "../../src/agent/tools/common.ts";
import type { PhoneCalendar, PhoneEvent } from "../../src/plugins/calendar.ts";
import type { Check } from "./setup.ts";

const GOOGLE = { accountType: "com.google", owner: "", own: true, primary: false };
const work: PhoneCalendar = { ...GOOGLE, id: 1, name: "work", account: "work@example.com", writable: true };
const home: PhoneCalendar = { ...GOOGLE, id: 2, name: "home", account: "home@example.com", writable: true };
const holidays: PhoneCalendar = { ...GOOGLE, id: 3, name: "holidays", account: "work@example.com", writable: false };

const at = Date.now() + 3_600_000;
const event = (id: string, calendar: PhoneCalendar, shared = false): PhoneEvent => ({ id, title: `title ${id}`, begin: at, end: at + 3_600_000, allDay: false, calendar: calendar.name, account: calendar.account, accountType: calendar.accountType, calendarId: calendar.id, ...(shared ? { shared } : {}) });

const key = (calendar: PhoneCalendar) => `${calendar.accountType}:${calendar.account}`;

function phone(access: Partial<CalendarAccess>) {
	const inserted: number[] = [];
	const deleted: string[] = [];
	const store: CalendarStore = {
		listAccounts: async () => ({ calendars: [work, home, holidays] }),
		listEvents: async ({ includeShared }) => ({ events: [event("w", work), event("h", home), ...(includeShared ? [event("s", work, true)] : [])] }),
		insertEvent: async ({ calendarId }) => (inserted.push(calendarId), { id: 9 }),
		deleteEvent: async ({ id }) => (deleted.push(id), { repeating: false }),
	};
	const tools = createCalendarExtension({ hidden: [], writable: [], shared: false, ...access }, store).tools ?? [];
	// why: these tools read nothing from their api; a whole Harness is not what these checks are about
	const api = {} as unknown as ToolExecutionApi;
	const run = (name: string, args: Record<string, unknown> = {}) => {
		const tool = tools.find((candidate) => candidate.name === name);
		assert(tool, `${name} exists`);
		return tool.execute(args, api, BACKGROUND_CONTEXT).then((result) => JSON.stringify(result));
	};
	return { run, inserted, deleted };
}

export const checks: Check[] = [
	[
		"an account the user hid is never read, and the bot is told not to bring it up",
		async () => {
			const seen = await phone({ hidden: [key(home)] }).run("read_calendar_events");
			assert.match(seen, /title w/);
			assert.doesNotMatch(seen, /title h/);
			assert.match(seen, /left out on purpose/);
		},
	],
	[
		"shared calendars stay closed until Settings opens them",
		async () => {
			await assert.rejects(phone({}).run("read_calendar_events", { include_shared: true }), /turned off in Settings/);
			assert.match(await phone({ shared: true }).run("read_calendar_events", { include_shared: true }), /title s/);
		},
	],
	[
		"only calendars of an account enabled for writing are offered, and a read-only one in it is not",
		async () => {
			const offered = await phone({ writable: [key(work)] }).run("list_calendars");
			assert.match(offered, /work/);
			assert.doesNotMatch(offered, /home|holidays/);
			assert.match(await phone({}).run("list_calendars"), /No calendar is enabled/);
		},
	],
	[
		"an account that is hidden cannot be written to, even if it was enabled for writing",
		async () => {
			assert.match(await phone({ writable: [key(home)], hidden: [key(home)] }).run("list_calendars"), /No calendar is enabled/);
		},
	],
	[
		"adding an event refuses a calendar Settings did not enable, and writes nothing",
		async () => {
			const { run, inserted } = phone({ writable: [key(work)] });
			await assert.rejects(run("add_calendar_event", { calendar_id: home.id, title: "x", start: localTime(at) }), /not enabled for writing/);
			assert.deepEqual(inserted, []);
			await run("add_calendar_event", { calendar_id: work.id, title: "x", start: localTime(at) });
			assert.deepEqual(inserted, [work.id]);
		},
	],
	[
		"deleting an event refuses a calendar Settings did not enable, and deletes nothing",
		async () => {
			const { run, deleted } = phone({ writable: [key(work)] });
			await assert.rejects(run("delete_calendar_event", { id: "h", start: localTime(at) }), /not enabled for writing/);
			assert.deepEqual(deleted, []);
			await run("delete_calendar_event", { id: "w", start: localTime(at) });
			assert.deepEqual(deleted, ["w"]);
		},
	],
];
