import type { TSchema } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import { type Static, type TLiteral, type TLiteralValue, type TSchemaOptions, type TUnion, Type } from "typebox";
import { Value } from "typebox/value";

type Literals<T extends readonly TLiteralValue[]> = { -readonly [K in keyof T]: T[K] extends TLiteralValue ? TLiteral<T[K]> : never };

export function oneOf<const T extends readonly TLiteralValue[]>(values: T, options?: TSchemaOptions): TUnion<Literals<T>> {
	// why: typebox's Static of a Union is never unless the members are a tuple type, and Array.map returns an array type, so the schemas built from a const list need their tuple type restored.
	const literals = values.map((value) => Type.Literal(value)) as unknown as [...Literals<T>];
	return Type.Union<Literals<T>>(literals, options);
}

function unset(value: unknown, schema: unknown): boolean {
	if (value === "" || value === null || (Array.isArray(value) && value.length === 0)) return true;
	if (value !== 0 || typeof schema !== "object" || schema === null) return false;
	const minimum = Reflect.get(schema, "minimum");
	const exclusive = Reflect.get(schema, "exclusiveMinimum");
	return (typeof minimum === "number" && minimum > 0) || (typeof exclusive === "number" && exclusive >= 0);
}

function cleaned(parameters: TSchema, raw: unknown): unknown {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
	const properties: unknown = Reflect.get(parameters, "properties");
	const required: unknown = Reflect.get(parameters, "required");
	const needed = new Set(Array.isArray(required) ? required : []);
	return Object.fromEntries(
		Object.entries(raw).filter(([key, value]) => needed.has(key) || !unset(value, typeof properties === "object" && properties !== null ? Reflect.get(properties, key) : undefined)),
	);
}

export function defineAppTool<TParameters extends TSchema, TDetails extends JsonValue = JsonValue>(
	tool: ToolRegistration<TParameters, TDetails>,
): ToolRegistration<TParameters, TDetails> {
	return defineTool({
		...tool,
		prepareArguments: (raw): Static<TParameters> => {
			const args = cleaned(tool.parameters, raw);
			if (Value.Check(tool.parameters, args)) return args;
			if (Value.Check(tool.parameters, raw)) return raw;
			const [first] = Value.Errors(tool.parameters, args);
			throw new Error(first ? `${first.instancePath || "arguments"} ${first.message}` : "invalid arguments");
		},
	});
}

export const text = (value: string): ToolExecutionResult => ({ output: [{ type: "text", text: value }] });

export const json = (value: unknown): ToolExecutionResult => text(JSON.stringify(value, null, 2));

const pad = (value: number) => String(value).padStart(2, "0");

export function localDate(ms: number): string {
	const date = new Date(ms);
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function localTime(ms: number): string {
	const date = new Date(ms);
	return `${localDate(ms)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
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

export function parseDay(value: string, field: string): number {
	const start = new Date();
	start.setHours(0, 0, 0, 0);
	if (value === "today") return start.getTime();
	if (value === "yesterday") return start.setDate(start.getDate() - 1);
	return parseLocalTime(value, field).ms;
}

export function duration(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	return minutes >= 60 ? `${Math.floor(minutes / 60)} 小時 ${minutes % 60} 分` : `${minutes} 分`;
}
