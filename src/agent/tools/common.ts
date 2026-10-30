import { CapacitorHttp } from "@capacitor/core";
import type { TSchema } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { isJsonValue, type JsonValue } from "@earendil-works/chord";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { parseJson } from "../parse.ts";
import type { PluginMethod } from "../../plugins/define.ts";

function unset(value: unknown, schema: unknown): boolean {
	if (value === "" || value === null || (Array.isArray(value) && value.length === 0)) return true;
	if (typeof schema !== "object" || schema === null) return false;
	if (typeof value === "boolean") return Reflect.get(schema, "type") === "string";
	if (value !== 0) return false;
	const minimum = Reflect.get(schema, "minimum");
	const exclusive = Reflect.get(schema, "exclusiveMinimum");
	return (typeof minimum === "number" && minimum > 0) || (typeof exclusive === "number" && exclusive >= 0);
}

function cleaned(parameters: TSchema, raw: unknown): unknown {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
	const properties: unknown = Reflect.get(parameters, "properties");
	const required: unknown = Reflect.get(parameters, "required");
	const needed = new Set(Array.isArray(required) ? required : []);
	const schemaOf = (key: string): unknown => (typeof properties === "object" && properties !== null ? Reflect.get(properties, key) : undefined);
	return Object.fromEntries(
		Object.entries(raw)
			.filter(([key, value]) => needed.has(key) || !unset(value, schemaOf(key)))
			.map(([key, value]) => [key, listed(value, schemaOf(key))]),
	);
}

function listed(value: unknown, schema: unknown): unknown {
	if (typeof schema !== "object" || schema === null || Reflect.get(schema, "type") !== "array") return value;
	const items = Array.isArray(value) ? value : typeof value === "string" || typeof value === "number" ? [value] : undefined;
	if (!items) return value;
	const field = soleTextField(Reflect.get(schema, "items"));
	return field ? items.map((item) => (typeof item === "string" ? { [field]: item } : item)) : items;
}

function soleTextField(schema: unknown): string | undefined {
	if (typeof schema !== "object" || schema === null || Reflect.get(schema, "type") !== "object") return undefined;
	const required: unknown = Reflect.get(schema, "required");
	const properties: unknown = Reflect.get(schema, "properties");
	if (!Array.isArray(required) || required.length !== 1 || typeof properties !== "object" || properties === null) return undefined;
	const [name]: unknown[] = required;
	if (typeof name !== "string") return undefined;
	const property: unknown = Reflect.get(properties, name);
	return typeof property === "object" && property !== null && Reflect.get(property, "type") === "string" ? name : undefined;
}

type Reach = "model" | "loaded" | "script";

export type Effect = "read" | "screen" | "direct";

interface ToolDeclaration {
	readonly effect: Effect;
	readonly needs: readonly PluginMethod[];
}

const REACH = { model: {}, loaded: { deferred: true }, script: { callers: ["tools"] } } as const;

const declarations = new WeakMap<object, ToolDeclaration>();

export const declarationOf = (tool: object): ToolDeclaration | undefined => declarations.get(tool);

export function defineAppTool<TParameters extends TSchema, TDetails extends JsonValue = JsonValue>({
	reach = "script",
	effect,
	needs = [],
	...tool
}: ToolRegistration<TParameters, TDetails> & { reach?: Reach; effect: Effect; needs?: readonly PluginMethod[] }): ToolRegistration<TParameters, TDetails> {
	const registration = defineTool({
		...tool,
		...REACH[reach],
		prepareArguments: (raw): Static<TParameters> => {
			const args = cleaned(tool.parameters, raw);
			if (Value.Check(tool.parameters, args)) return args;
			if (Value.Check(tool.parameters, raw)) return raw;
			const [first] = Value.Errors(tool.parameters, args);
			throw new Error(first ? `${first.instancePath || "arguments"} ${first.message}` : "invalid arguments");
		},
	});
	declarations.set(registration, { effect, needs });
	return registration;
}

export const text = (value: string): ToolExecutionResult => ({ output: [{ type: "text", text: value }] });

export const json = (value: unknown): ToolExecutionResult => text(JSON.stringify(value, null, 2));

const MAX_OUTPUT_CHARS = 40_000;

export function truncated(value: string, hint = ""): string {
	return value.length > MAX_OUTPUT_CHARS ? `${value.slice(0, MAX_OUTPUT_CHARS)}\n\n[truncated: ${value.length - MAX_OUTPUT_CHARS} more characters${hint}]` : value;
}

export const jsonOrNull = (value: unknown): JsonValue => (isJsonValue(value) ? value : null);

export const HOUR = 3_600_000;
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

const HEADERS = { "User-Agent": "pi-mobile (+https://github.com/geminixiang/pi-mobile)", Accept: "application/json" };
const TIMEOUTS = { connectTimeout: 10_000, readTimeout: 20_000 };

export async function getJson(url: string, what: string, signal?: AbortSignal): Promise<unknown> {
	signal?.throwIfAborted();
	const response = await CapacitorHttp.get({ url, headers: HEADERS, ...TIMEOUTS });
	if (response.status !== 200) throw new Error(`${what}: HTTP ${response.status}`);
	return typeof response.data === "string" ? parseJson(response.data, what) : response.data;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
