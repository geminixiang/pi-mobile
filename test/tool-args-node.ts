// defineAppTool's argument cleaning (src/agent/tools/common.ts), the time formats, and code mode's output shapes, which every app tool relies on: optional arguments a
// model left empty ("", null, or a 0 the schema rules out) count as not given; real values stay, valid or not.
// Run by `npm run check`.
import { deepStrictEqual, throws } from "node:assert/strict";
import { Type } from "typebox";
import { signatureOf } from "../src/agent/codemode.ts";
import { defineAppTool, parseLocalBound, parseLocalTime, parseNextTime } from "../src/agent/tools/common.ts";

const tool = defineAppTool({
	name: "probe",
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

// Empty optionals go; a required "" stays (an empty path means the root).
deepStrictEqual(prepare({ need: "", query: "", limit: 0, radius_km: 0, images: false }), { need: "", images: false });
deepStrictEqual(prepare({ need: "a", query: null, days: [] }), { need: "a" });
// 0 stays where the schema allows it.
deepStrictEqual(prepare({ need: "a", offset: 0 }), { need: "a", offset: 0 });
// A real value below the minimum is not "empty": it is invalid, and the model is told.
throws(() => prepare({ need: "a", radius_m: 50 }), /radius_m/);
// Valid arguments pass through.
deepStrictEqual(prepare({ need: "a", query: "x", limit: 3 }), { need: "a", query: "x", limit: 3 });

// Times: local wall-clock forms in, with or without a T.
deepStrictEqual(parseLocalTime("2026-10-22 07:05", "at"), { ms: new Date(2026, 9, 22, 7, 5).getTime(), hasTime: true });
deepStrictEqual(parseLocalTime("2026-10-22T07:05", "at").ms, new Date(2026, 9, 22, 7, 5).getTime());
deepStrictEqual(parseLocalTime("2026-10-22", "from"), { ms: new Date(2026, 9, 22).getTime(), hasTime: false });
deepStrictEqual(parseLocalBound("2026-10-22", "to", true), new Date(2026, 9, 23).getTime());
throws(() => parseLocalTime("2026-02-30", "at"), /not a real date/);
throws(() => parseLocalTime("10/22 07:00", "at"), /YYYY-MM-DD HH:MM/);
const next = parseNextTime("07:00", "until");
if (next <= Date.now() || next - Date.now() > 86_400_000) throw new Error("07:00 is the next 07:00");

// Code mode's index shows each script-only tool as its name and argument names, read from the schema.
deepStrictEqual(signatureOf({ name: "weather", parameters: Type.Object({ place: Type.String(), days: Type.Optional(Type.Integer()) }) }), "weather(place, days?)");

console.log("tool arguments: cleaning, time parsing, and code mode signatures behave");
