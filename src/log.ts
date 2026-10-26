type Fields = Record<string, string | number | boolean | undefined>;
type Level = "info" | "warn" | "error";

const RECENT_LIMIT = 2000;
const STALL_TICK_MS = 250;
const STALL_LIMIT_MS = 500;
const SECRET = /\b(?:gh[pousr]_|github_pat_|sk-|xox[abp]-|ya29\.)[A-Za-z0-9_.-]+|Bearer [A-Za-z0-9_.-]+/g;

const recent: string[] = [];

function scrubbed(fields: Fields): Fields {
	return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, typeof value === "string" ? value.replace(SECRET, "[redacted]") : value]));
}

function write(level: Level, event: string, fields: Fields): void {
	const entry = { event, ...scrubbed(fields) };
	console[level](JSON.stringify(entry));
	recent.push(JSON.stringify({ at: new Date().toISOString(), level, ...entry }));
	if (recent.length > RECENT_LIMIT) recent.shift();
}

export const log = {
	info: (event: string, fields: Fields = {}) => write("info", event, fields),
	warn: (event: string, fields: Fields = {}) => write("warn", event, fields),
	error: (event: string, fields: Fields = {}) => write("error", event, fields),
};

export function recentLog(): string {
	return `${recent.join("\n")}\n`;
}

export function watchMainThread(): () => void {
	let last = performance.now();
	let visible = document.visibilityState === "visible";
	const tick = () => {
		const now = performance.now();
		const gap = now - last;
		const visibleNow = document.visibilityState === "visible";
		if (visible && visibleNow && gap > STALL_LIMIT_MS) log.warn("ui.stall", { gapMs: Math.round(gap) });
		last = now;
		visible = visibleNow;
	};
	const timer = setInterval(tick, STALL_TICK_MS);
	const onVisibility = () => {
		last = performance.now();
		visible = document.visibilityState === "visible";
	};
	document.addEventListener("visibilitychange", onVisibility);
	return () => {
		clearInterval(timer);
		document.removeEventListener("visibilitychange", onVisibility);
	};
}
