// Which calendars the agent may read and write, set per account in Settings and stored as JSON in `calendarAccess`.
// A phone often mixes personal and work accounts: work calendars may not be allowed to reach a third-party model at
// all, and an event written to the wrong account is embarrassing. Shared calendars (a team's, a colleague's) hold
// other people's events: they are read only when turned on, and never written to.
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const CalendarAccess = Type.Object({
	/** Accounts whose own calendars the agent may not read; every other account is readable. */
	hidden: Type.Array(Type.String()),
	/** Accounts whose own calendars the agent may add events to. */
	writable: Type.Array(Type.String()),
	/** Calendar id events go to when the user names none. */
	defaultCalendar: Type.Optional(Type.Integer()),
	/** Whether shared calendars can be read on request. */
	shared: Type.Boolean(),
});
export type CalendarAccess = Static<typeof CalendarAccess>;

/** Every own calendar readable, nothing writable until the user picks, shared calendars off. */
export const DEFAULT_CALENDAR_ACCESS: CalendarAccess = { hidden: [], writable: [], shared: false };

/** An account is its name and type: one address can be a Google account and a Samsung account. */
export function accountKey(calendar: { account: string; accountType: string }): string {
	return `${calendar.accountType}:${calendar.account}`;
}

/** Stored access; empty or unreadable means the defaults. */
export function parseCalendarAccess(json: string): CalendarAccess {
	if (!json) return DEFAULT_CALENDAR_ACCESS;
	try {
		const value: unknown = JSON.parse(json);
		return Value.Check(CalendarAccess, value) ? value : DEFAULT_CALENDAR_ACCESS;
	} catch {
		return DEFAULT_CALENDAR_ACCESS;
	}
}

export function canRead(access: CalendarAccess, calendar: { account: string; accountType: string; shared: boolean }): boolean {
	return calendar.shared ? access.shared : !access.hidden.includes(accountKey(calendar));
}

export function canWrite(access: CalendarAccess, calendar: { account: string; accountType: string }): boolean {
	return access.writable.includes(accountKey(calendar)) && !access.hidden.includes(accountKey(calendar));
}
