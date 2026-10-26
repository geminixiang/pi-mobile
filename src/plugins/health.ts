import { type Static, Type } from "typebox";
import { definePlugin } from "./define.ts";
import { oneOf } from "../agent/tools/common.ts";

export const METRICS = ["steps", "heart_rate", "sleep", "exercise", "weight"] as const;

const HealthRecord = Type.Object({
	source: Type.String(),
	start: Type.Optional(Type.Number()),
	end: Type.Optional(Type.Number()),
	time: Type.Optional(Type.Number()),
	stageMinutes: Type.Optional(Type.Record(Type.String(), Type.Number())),
	type: Type.Optional(Type.Number()),
	title: Type.Optional(Type.String()),
	kg: Type.Optional(Type.Number()),
});
export type HealthRecord = Static<typeof HealthRecord>;

export const Health = definePlugin("Health", {
	read: {
		args: Type.Object({ metric: oneOf(METRICS), days: Type.Number() }),
		result: Type.Object({
			days: Type.Optional(Type.Array(Type.Object({ day: Type.String(), value: Type.Number() }))),
			records: Type.Optional(Type.Array(HealthRecord)),
		}),
	},
});
