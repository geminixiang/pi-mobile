export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const pad = (value: number) => String(value).padStart(2, "0");

export function localDate(ms: number): string {
	const date = new Date(ms);
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export const weekdayOf = (date: string) => new Date(`${date.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });

export function localTime(ms: number): string {
	const date = new Date(ms);
	return `${localDate(ms)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function monthDayTime(ms: number): string {
	const date = new Date(ms);
	return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function parseLocalTime(value: string, field: string): { ms: number; hasTime: boolean } {
	const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?$/.exec(value.trim());
	if (!match) throw new Error(`${field} must be local time YYYY-MM-DD HH:MM, or a date YYYY-MM-DD; got ${JSON.stringify(value)}`);
	const [, year, month, day, hour, minute] = match;
	const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour ?? 0), Number(minute ?? 0));
	if (date.getMonth() !== Number(month) - 1 || Number(hour ?? 0) > 23 || Number(minute ?? 0) > 59) throw new Error(`${field} is not a real date or time: ${value}`);
	return { ms: date.getTime(), hasTime: hour !== undefined };
}

export function parseLocalBound(value: string, field: string, end: boolean): number {
	const { ms, hasTime } = parseLocalTime(value, field);
	return end && !hasTime ? new Date(ms).setHours(24, 0, 0, 0) : ms;
}

export function parseClock(value: string, field: string): { text: string; hour: number; minute: number } {
	const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
	const hour = Number(match?.[1]);
	const minute = Number(match?.[2]);
	if (!match || hour > 23 || minute > 59) throw new Error(`${field} must be a 24-hour local time HH:MM; got ${JSON.stringify(value)}`);
	return { text: `${pad(hour)}:${pad(minute)}`, hour, minute };
}

export function parseNextTime(value: string, field: string): number {
	if (/^\d{1,2}:\d{2}$/.test(value.trim())) {
		const { hour, minute } = parseClock(value, field);
		const at = new Date();
		at.setHours(hour, minute, 0, 0);
		if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1);
		return at.getTime();
	}
	return parseLocalTime(value, field).ms;
}

export function startOfToday(): number {
	return new Date().setHours(0, 0, 0, 0);
}

export function parseDay(value: string, field: string): number {
	if (value === "today") return startOfToday();
	if (value === "yesterday") {
		const start = new Date(startOfToday());
		return start.setDate(start.getDate() - 1);
	}
	return parseLocalTime(value, field).ms;
}

export function duration(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	return minutes >= 60 ? `${Math.floor(minutes / 60)} 小時 ${minutes % 60} 分` : `${minutes} 分`;
}
