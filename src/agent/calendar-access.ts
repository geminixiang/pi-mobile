import { type Static, Type } from "typebox";
import { decode } from "./parse.ts";

const CalendarAccess = Type.Object({
	hidden: Type.Array(Type.String()),
	writable: Type.Array(Type.String()),
	defaultCalendar: Type.Optional(Type.Integer()),
	shared: Type.Boolean(),
});
export type CalendarAccess = Static<typeof CalendarAccess>;

export const DEFAULT_CALENDAR_ACCESS: CalendarAccess = { hidden: [], writable: [], shared: false };

export function accountKey(calendar: { account: string; accountType: string }): string {
	return `${calendar.accountType}:${calendar.account}`;
}

export function parseCalendarAccess(json: string): CalendarAccess {
	return decode(CalendarAccess, json) ?? DEFAULT_CALENDAR_ACCESS;
}

export function canRead(access: CalendarAccess, calendar: { account: string; accountType: string; shared: boolean }): boolean {
	return calendar.shared ? access.shared : !access.hidden.includes(accountKey(calendar));
}

export function canWrite(access: CalendarAccess, calendar: { account: string; accountType: string }): boolean {
	return access.writable.includes(accountKey(calendar)) && !access.hidden.includes(accountKey(calendar));
}
