import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

export type Checked<T> = { ok: true; value: T } | { ok: false; problem: string };

const NOT_JSON = Symbol("not JSON");

function jsonOrMarker(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return NOT_JSON;
	}
}

export function check<T extends TSchema>(schema: T, value: unknown, what: string): Checked<Static<T>> {
	if (Value.Check(schema, value)) return { ok: true, value };
	const [first] = Value.Errors(schema, value);
	return { ok: false, problem: `${what}格式不符${first ? `：${first.instancePath || "/"} ${first.message}` : ""}` };
}

export function checkJson<T extends TSchema>(schema: T, text: string, what: string): Checked<Static<T>> {
	const value = jsonOrMarker(text);
	if (value === NOT_JSON) return { ok: false, problem: `${what}不是有效的 JSON` };
	return check(schema, value, what);
}

function valueOrThrow<T>(checked: Checked<T>): T {
	if (!checked.ok) throw new Error(checked.problem);
	return checked.value;
}

export function parse<T extends TSchema>(schema: T, value: unknown, what: string): Static<T> {
	return valueOrThrow(check(schema, value, what));
}

export function hostOf(url: string): string {
	return URL.canParse(url) ? new URL(url).host : url;
}

export function jsonOrText(text: string): unknown {
	const value = jsonOrMarker(text);
	return value === NOT_JSON ? text : value;
}

export function parseJson(text: string, what: string): unknown {
	const value = jsonOrMarker(text);
	if (value === NOT_JSON) throw new Error(`${what}不是有效的 JSON`);
	return value;
}

export function decode<T extends TSchema>(schema: T, text: string | null | undefined): Static<T> | undefined {
	if (!text) return undefined;
	const checked = checkJson(schema, text, "");
	return checked.ok ? checked.value : undefined;
}

export function readStored<T extends TSchema>(schema: T, key: string): Static<T> | undefined {
	return decode(schema, localStorage.getItem(key));
}
