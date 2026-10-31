import { deepStrictEqual, match, throws } from "node:assert/strict";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { signatureOf } from "../src/agent/codemode.ts";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { oneOf } from "../src/agent/parse.ts";
import { defineAppTool, parseLocalBound, parseLocalTime, parseNextTime } from "../src/agent/tools/common.ts";

const tool = defineAppTool({
	name: "probe",
	effect: "read",
	description: "A tool to check argument cleaning with.",
	parameters: Type.Object({
		need: Type.String(),
		query: Type.Optional(Type.String()),
		limit: Type.Optional(Type.Integer({ minimum: 1 })),
		radius_m: Type.Optional(Type.Integer({ minimum: 100 })),
		offset: Type.Optional(Type.Integer({ minimum: 0 })),
		radius_km: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
		images: Type.Optional(Type.Boolean()),
		days: Type.Optional(Type.Array(Type.String())),
	}),
	execute: async () => ({ output: [] }),
});
const prepare = (args: unknown) => tool.prepareArguments?.(args);

const picker = { name: "picker", description: "", parameters: Type.Object({ data: oneOf(["prices", "margin"]) }) };
throws(() => validateToolArguments(picker, { type: "toolCall", id: "1", name: "picker", arguments: { data: "price" } }), /must be one of "prices", "margin"/);
match([...Value.Errors(picker.parameters, "prices")][0]?.message ?? "", /one object of named arguments/);
match([...Value.Errors(Type.Object({ stocks: Type.Array(Type.String()) }), { stocks: "2330" })][0]?.message ?? "", /an array, even for one value/);

deepStrictEqual(prepare({ need: "", query: "", limit: 0, radius_km: 0, images: false }), { need: "", images: false });
deepStrictEqual(prepare({ need: "a", query: null, days: [] }), { need: "a" });
deepStrictEqual(prepare({ need: "a", offset: 0 }), { need: "a", offset: 0 });
throws(() => prepare({ need: "a", radius_m: 50 }), /radius_m/);
deepStrictEqual(prepare({ need: "a", query: "x", limit: 3 }), { need: "a", query: "x", limit: 3 });
deepStrictEqual(prepare({ need: "a", days: "Mon" }), { need: "a", days: ["Mon"] });
deepStrictEqual(prepare({ need: "a", query: true, images: true }), { need: "a", images: true });
deepStrictEqual(prepare({ need: "a", limit: "3", radius_km: " 1.5" }), { need: "a", limit: 3, radius_km: 1.5 });
deepStrictEqual(prepare({ need: "1" }), { need: "1" });
throws(() => prepare({ need: "a", limit: "three" }), /limit/);

const statements = defineAppTool({
	name: "statements",
	effect: "read",
	description: "A tool whose list items are objects with one required text field.",
	parameters: Type.Object({
		statements: Type.Array(Type.Object({ sql: Type.String(), params: Type.Optional(Type.Array(Type.String())) }), { minItems: 1 }),
	}),
	execute: async () => ({ output: [] }),
});
const prepareStatements = (args: unknown) => statements.prepareArguments?.(args);
deepStrictEqual(prepareStatements({ statements: ["SELECT 1", { sql: "SELECT ?", params: ["a"] }] }), {
	statements: [{ sql: "SELECT 1" }, { sql: "SELECT ?", params: ["a"] }],
});
deepStrictEqual(prepareStatements({ statements: "SELECT 1" }), { statements: [{ sql: "SELECT 1" }] });
throws(() => prepareStatements({ statements: [7] }), /statements\/0/);
deepStrictEqual(prepareStatements({ statements: [{ sql: "SELECT 1", params: [] }] }), { statements: [{ sql: "SELECT 1" }] });

const steps = defineAppTool({
	name: "steps",
	effect: "read",
	description: "A tool whose list items carry optional fields a model may fill with blanks.",
	parameters: Type.Object({
		steps: Type.Array(Type.Object({ action: Type.String(), text: Type.Optional(Type.String()), ms: Type.Optional(Type.Integer({ minimum: 1 })) })),
	}),
	execute: async () => ({ output: [] }),
});
deepStrictEqual(steps.prepareArguments?.({ steps: [{ action: "wait", text: "", ms: 0 }] }), { steps: [{ action: "wait" }] });

deepStrictEqual(parseLocalTime("2026-10-22 07:05", "at"), { ms: new Date(2026, 9, 22, 7, 5).getTime(), hasTime: true });
deepStrictEqual(parseLocalTime("2026-10-22T07:05", "at").ms, new Date(2026, 9, 22, 7, 5).getTime());
deepStrictEqual(parseLocalTime("2026-10-22", "from"), { ms: new Date(2026, 9, 22).getTime(), hasTime: false });
deepStrictEqual(parseLocalBound("2026-10-22", "to", true), new Date(2026, 9, 23).getTime());
throws(() => parseLocalTime("2026-02-30", "at"), /not a real date/);
throws(() => parseLocalTime("10/22 07:00", "at"), /YYYY-MM-DD HH:MM/);
const next = parseNextTime("07:00", "until");
if (next <= Date.now() || next - Date.now() > 86_400_000) throw new Error("07:00 is the next 07:00");

deepStrictEqual(signatureOf({ name: "weather", parameters: Type.Object({ place: Type.String(), days: Type.Optional(Type.Integer()) }) }), "weather(place, days?)");

console.log("tool arguments: cleaning, time parsing, and code mode signatures behave");
