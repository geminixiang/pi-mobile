// Structured diagnostics: one event name plus fields, as one JSON line, so `adb logcat` (Chromium console) output can
// be searched by event and correlated by conversation or sandbox. The only place that writes to the console.
type Fields = Record<string, string | number | boolean | undefined>;

function write(level: "info" | "warn" | "error", event: string, fields: Fields): void {
	console[level](JSON.stringify({ event, ...fields }));
}

export const log = {
	info: (event: string, fields: Fields = {}) => write("info", event, fields),
	warn: (event: string, fields: Fields = {}) => write("warn", event, fields),
	error: (event: string, fields: Fields = {}) => write("error", event, fields),
};
