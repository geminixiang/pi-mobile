// Boundary parsing: data from outside (HTTP responses, pi-host, storage) is `unknown` until a schema checks it.
// Types inside the app are inferred from these schemas, so the check and the type cannot drift apart.
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

/** Validate `value` against `schema`, or throw naming `what` and the first mismatch. */
export function parse<T extends TSchema>(schema: T, value: unknown, what: string): Static<T> {
	if (Value.Check(schema, value)) return value;
	const [first] = Value.Errors(schema, value);
	throw new Error(`${what}格式不符${first ? `：${first.instancePath || "/"} ${first.message}` : ""}`);
}

/** Parse JSON text into `unknown`; the caller still checks the shape. Throws with `what` on invalid JSON. */
export function parseJson(text: string, what: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`${what}不是有效的 JSON`);
	}
}
