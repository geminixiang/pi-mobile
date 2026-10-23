import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

export function parse<T extends TSchema>(schema: T, value: unknown, what: string): Static<T> {
	if (Value.Check(schema, value)) return value;
	const [first] = Value.Errors(schema, value);
	throw new Error(`${what}格式不符${first ? `：${first.instancePath || "/"} ${first.message}` : ""}`);
}

const NOT_JSON = Symbol("not JSON");

function jsonOrMarker(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return NOT_JSON;
	}
}

export function isJson(text: string): boolean {
	return jsonOrMarker(text) !== NOT_JSON;
}

export function parseJson(text: string, what: string): unknown {
	const value = jsonOrMarker(text);
	if (value === NOT_JSON) throw new Error(`${what}不是有效的 JSON`);
	return value;
}

export function decode<T extends TSchema>(schema: T, text: string | null | undefined): Static<T> | undefined {
	if (!text) return undefined;
	const value = jsonOrMarker(text);
	return Value.Check(schema, value) ? value : undefined;
}

export function readStored<T extends TSchema>(schema: T, key: string): Static<T> | undefined {
	return decode(schema, localStorage.getItem(key));
}
