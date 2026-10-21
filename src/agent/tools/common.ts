// What every app tool shares, so they behave alike to the model (docs/tools.md § 介面規範): how a tool is defined
// (defineAppTool cleans the arguments models fill in), how times go in and out, and how results, refusals, and
// declined approvals read.
import { Capacitor } from "@capacitor/core";
import type { TSchema } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { requestConfirmation } from "../confirm.ts";

// ─── Definition ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * An optional argument the model left at an empty value, which it means as not given: "", null, [], and 0 where
 * the schema does not allow 0 (limit, days, radius_km). An optional list left empty means none, as omitting it does. Models often fill every optional field that way.
 */
function unset(value: unknown, schema: unknown): boolean {
	if (value === "" || value === null || (Array.isArray(value) && value.length === 0)) return true;
	if (value !== 0 || typeof schema !== "object" || schema === null) return false;
	// Only 0, and only where the schema rules it out: 50 for a minimum of 100 is a real value, and invalid.
	const minimum = Reflect.get(schema, "minimum");
	const exclusive = Reflect.get(schema, "exclusiveMinimum");
	return (typeof minimum === "number" && minimum > 0) || (typeof exclusive === "number" && exclusive >= 0);
}

/** The arguments without the optional ones the model left empty. */
function cleaned(parameters: TSchema, raw: unknown): unknown {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
	const properties: unknown = Reflect.get(parameters, "properties");
	const required: unknown = Reflect.get(parameters, "required");
	const needed = new Set(Array.isArray(required) ? required : []);
	return Object.fromEntries(
		Object.entries(raw).filter(([key, value]) => needed.has(key) || !unset(value, typeof properties === "object" && properties !== null ? Reflect.get(properties, key) : undefined)),
	);
}

/**
 * defineTool for the app's tools: the same registration, with arguments cleaned before validation (an optional "",
 * null, or out-of-range 0 counts as omitted), so no tool has to treat those itself.
 */
export function defineAppTool<TParameters extends TSchema, TDetails extends JsonValue = JsonValue>(
	tool: ToolRegistration<TParameters, TDetails>,
): ToolRegistration<TParameters, TDetails> {
	return defineTool({
		...tool,
		prepareArguments: (raw): Static<TParameters> => {
			const args = cleaned(tool.parameters, raw);
			if (Value.Check(tool.parameters, args)) return args;
			if (Value.Check(tool.parameters, raw)) return raw;
			// Invalid either way: the Harness reports it to the model as invalid arguments.
			const [first] = Value.Errors(tool.parameters, args);
			throw new Error(first ? `${first.instancePath || "arguments"} ${first.message}` : "invalid arguments");
		},
	});
}

// ─── Results ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** A text result for the model. */
export const text = (value: string): ToolExecutionResult => ({ output: [{ type: "text", text: value }] });

/** Records as indented JSON text, for a tool without a structured output. */
export const json = (value: unknown): ToolExecutionResult => text(JSON.stringify(value, null, 2));

/** Throws unless pi runs as the Android app (in a browser the plugins are not there). */
export function requireNative(): void {
	if (!Capacitor.isNativePlatform()) throw new Error("only available in the Android app");
}

/**
 * Ask the user to approve an action (a dialog, or a notification while pi is away). Declined: the result tells the
 * model to say so in one sentence, `reply`, and stop; undefined when approved, so the tool goes on.
 */
export async function approve(request: { title: string; detail: string }, reply: string): Promise<ToolExecutionResult | undefined> {
	if (await requestConfirmation(request)) return undefined;
	return {
		output: [
			{
				type: "text",
				text: `The user declined; nothing was done. Reply with one short sentence that says so, such as 「${reply}」; do not list what it would have been, offer alternatives, or ask why.`,
			},
		],
		isError: true,
	};
}

// ─── Times ───────────────────────────────────────────────────────────────────────────────────────────────────────
// In: local wall-clock time "YYYY-MM-DD HH:MM" (a T between is fine), a date "YYYY-MM-DD", or a clock time "HH:MM".
// Out: the same local forms, so what the model reads it can pass back.

const pad = (value: number) => String(value).padStart(2, "0");

/** "YYYY-MM-DD" of a local instant. */
export function localDate(ms: number): string {
	const date = new Date(ms);
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "YYYY-MM-DD HH:MM" of a local instant. */
export function localTime(ms: number): string {
	const date = new Date(ms);
	return `${localDate(ms)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A local date or date and time, as its instant and whether it had a time. A date alone is its start. */
export function parseLocalTime(value: string, field: string): { ms: number; hasTime: boolean } {
	const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?$/.exec(value.trim());
	if (!match) throw new Error(`${field} must be local time YYYY-MM-DD HH:MM, or a date YYYY-MM-DD; got ${JSON.stringify(value)}`);
	const [, year, month, day, hour, minute] = match;
	const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour ?? 0), Number(minute ?? 0));
	if (date.getMonth() !== Number(month) - 1 || Number(hour ?? 0) > 23 || Number(minute ?? 0) > 59) throw new Error(`${field} is not a real date or time: ${value}`);
	return { ms: date.getTime(), hasTime: hour !== undefined };
}

/** A local range bound: a date alone means its start, or with `end` the end of that day. */
export function parseLocalBound(value: string, field: string, end: boolean): number {
	const { ms, hasTime } = parseLocalTime(value, field);
	return end && !hasTime ? new Date(ms).setHours(24, 0, 0, 0) : ms;
}

/** "HH:MM", padded. */
export function parseClock(value: string, field: string): { text: string; hour: number; minute: number } {
	const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
	const hour = Number(match?.[1]);
	const minute = Number(match?.[2]);
	if (!match || hour > 23 || minute > 59) throw new Error(`${field} must be a 24-hour local time HH:MM; got ${JSON.stringify(value)}`);
	return { text: `${pad(hour)}:${pad(minute)}`, hour, minute };
}

/** A clock time's next occurrence ("07:00" tonight or tomorrow), or a local date and time, as an instant. */
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

/** Local midnight of "today", "yesterday", or a date. */
export function parseDay(value: string, field: string): number {
	const start = new Date();
	start.setHours(0, 0, 0, 0);
	if (value === "today") return start.getTime();
	if (value === "yesterday") return start.setDate(start.getDate() - 1);
	return parseLocalTime(value, field).ms;
}

/** A duration as "N 小時 M 分" or "M 分", the way the user reads it. */
export function duration(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	return minutes >= 60 ? `${Math.floor(minutes / 60)} 小時 ${minutes % 60} 分` : `${minutes} 分`;
}
