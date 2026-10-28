import { type Static, Type } from "typebox";
import { decode } from "./parse.ts";
import type { PhoneCalendar } from "../plugins/calendar.ts";

const CalendarAccess = Type.Object({
	hidden: Type.Array(Type.String()),
	writable: Type.Array(Type.String()),
	defaultCalendar: Type.Optional(Type.Integer()),
	shared: Type.Boolean(),
});
export type CalendarAccess = Static<typeof CalendarAccess>;

export const DEFAULT_CALENDAR_ACCESS: CalendarAccess = { hidden: [], writable: [], shared: false };

function accountKey(calendar: { account: string; accountType: string }): string {
	return `${calendar.accountType}:${calendar.account}`;
}

export function parseCalendarAccess(json: string | undefined): CalendarAccess {
	return decode(CalendarAccess, json) ?? DEFAULT_CALENDAR_ACCESS;
}

export function canRead(access: CalendarAccess, calendar: { account: string; accountType: string; shared: boolean }): boolean {
	return calendar.shared ? access.shared : !access.hidden.includes(accountKey(calendar));
}

export function canWrite(access: CalendarAccess, calendar: { account: string; accountType: string }): boolean {
	return access.writable.includes(accountKey(calendar)) && !access.hidden.includes(accountKey(calendar));
}

export function accountLabel(calendar: { account: string; accountType: string }): string {
	if (calendar.accountType === "com.google") return calendar.account;
	if (calendar.accountType === "LOCAL") return "這支手機";
	if (calendar.accountType === "com.osp.app.signin") return `${calendar.account}（Samsung 帳號）`;
	return `${calendar.account}（${calendar.accountType}）`;
}

export function groupByAccount(calendars: PhoneCalendar[]): { key: string; label: string; calendars: PhoneCalendar[] }[] {
	const groups = new Map<string, { key: string; label: string; calendars: PhoneCalendar[] }>();
	for (const calendar of calendars) {
		if (!calendar.own) continue;
		const key = accountKey(calendar);
		const label = calendar.accountType === "LOCAL" ? `${calendar.name}（只在這支手機上）` : accountLabel(calendar);
		const group = groups.get(key) ?? { key, label, calendars: [] };
		group.calendars.push(calendar);
		groups.set(key, group);
	}
	return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}
