import { type Static, Type } from "typebox";
import { definePlugin } from "./define.ts";

const PhoneCalendar = Type.Object({
	id: Type.Number(),
	name: Type.String(),
	account: Type.String(),
	accountType: Type.String(),
	owner: Type.String(),
	own: Type.Boolean(),
	writable: Type.Boolean(),
	primary: Type.Boolean(),
});
export type PhoneCalendar = Static<typeof PhoneCalendar>;

const PhoneEvent = Type.Object({
	id: Type.String(),
	title: Type.String(),
	begin: Type.Number(),
	end: Type.Number(),
	allDay: Type.Boolean(),
	location: Type.Optional(Type.String()),
	notes: Type.Optional(Type.String()),
	calendar: Type.String(),
	account: Type.String(),
	accountType: Type.String(),
	calendarId: Type.Number(),
	shared: Type.Optional(Type.Boolean()),
	owner: Type.Optional(Type.String()),
});
export type PhoneEvent = Static<typeof PhoneEvent>;

export const Calendar = definePlugin("Calendar", {
	listAccounts: { args: Type.Object({}), result: Type.Object({ calendars: Type.Array(PhoneCalendar) }) },
	listEvents: { args: Type.Object({ from: Type.Number(), to: Type.Number(), includeShared: Type.Boolean() }), result: Type.Object({ events: Type.Array(PhoneEvent) }) },
	insertEvent: {
		args: Type.Object({
			calendarId: Type.Number(),
			title: Type.String(),
			begin: Type.Number(),
			end: Type.Number(),
			allDay: Type.Boolean(),
			location: Type.Optional(Type.String()),
			description: Type.Optional(Type.String()),
		}),
		result: Type.Object({ id: Type.Union([Type.Number(), Type.String()]) }),
	},
	deleteEvent: { args: Type.Object({ id: Type.String(), begin: Type.Number(), all: Type.Boolean() }), result: Type.Object({ repeating: Type.Boolean() }) },
	checkPermissions: { args: Type.Object({}), result: Type.Object({ calendar: Type.String() }) },
});
