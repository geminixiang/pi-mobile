// health: the user's Health Connect data, read-only (HealthPlugin.java): steps and average heart rate per day, sleep
// and exercise sessions, weight. Samsung Health, Fitbit, and others write there when their sync is on.
import { registerPlugin } from "@capacitor/core";
import { Type } from "typebox";
import { defineExtension } from "@earendil-works/pi-durable";
import { defineAppTool, duration, localTime, requireNative, text } from "./common.ts";

type Metric = "steps" | "heart_rate" | "sleep" | "exercise" | "weight";
// A type, not an interface: structured outputs must be JSON-assignable.
type HealthRecord = {
	source: string;
	start?: number;
	end?: number;
	time?: number;
	stageMinutes?: Record<string, number>;
	type?: number;
	title?: string;
	kg?: number;
};

const Health = registerPlugin<{
	read(options: { metric: Metric; days: number }): Promise<{ days?: { day: string; value: number }[]; records?: HealthRecord[] }>;
}>("Health");

const health = defineAppTool({
	name: "health",
	description:
		"The user's health data from Health Connect (Samsung Health and other apps sync there): steps or average heart rate per day, sleep sessions with stages, exercise sessions, weight. Use it for 「我這週睡得怎樣」「今天走幾步」.",
	parameters: Type.Object({
		metric: Type.Union([Type.Literal("steps"), Type.Literal("heart_rate"), Type.Literal("sleep"), Type.Literal("exercise"), Type.Literal("weight")], {
			description: "steps and heart_rate are per day; sleep and exercise are sessions; weight is measurements",
		}),
		days: Type.Optional(Type.Integer({ minimum: 1, maximum: 90, description: "The last this many days, today included (default 7)" })),
	}),
	structuredOutputSchema: Type.Object({
		days: Type.Optional(Type.Array(Type.Object({ day: Type.String({ description: "YYYY-MM-DD" }), value: Type.Number({ description: "Steps, or average bpm" }) }))),
		records: Type.Optional(
			Type.Array(
				Type.Object({
					source: Type.String({ description: "The app that wrote it" }),
					start: Type.Optional(Type.String({ description: "Local time, YYYY-MM-DD HH:MM" })),
					end: Type.Optional(Type.String({ description: "Local time, YYYY-MM-DD HH:MM" })),
					time: Type.Optional(Type.String({ description: "Local time, YYYY-MM-DD HH:MM" })),
					stage_minutes: Type.Optional(Type.Record(Type.String(), Type.Number(), { description: "Sleep: minutes awake, light, deep, rem" })),
					title: Type.Optional(Type.String()),
					exercise_type: Type.Optional(Type.Integer({ description: "Health Connect's exercise type number" })),
					kg: Type.Optional(Type.Number()),
				}),
			),
		),
	}),
	execute: async (args) => {
		requireNative();
		const days = args.days ?? 7;
		const result = await Health.read({ metric: args.metric, days });
		const none = `No ${args.metric.replace("_", " ")} data in Health Connect for the last ${days} days. If the user tracks it in Samsung Health, it writes there only with 同意處理健康和保健資料 on (Samsung Health › 設定) and Health Connect allowed.`;
		if (result.days) {
			const structuredOutput = { days: result.days };
			if (result.days.length === 0) return { ...text(none), structuredOutput };
			const unit = args.metric === "steps" ? "步" : "bpm";
			return { ...text(result.days.map((day) => `${day.day}: ${Math.round(day.value)} ${unit}`).join("\n")), structuredOutput };
		}
		const records = result.records ?? [];
		const structuredOutput = {
			records: records.map((record) => ({
				source: record.source,
				...(record.start !== undefined ? { start: localTime(record.start) } : {}),
				...(record.end !== undefined ? { end: localTime(record.end) } : {}),
				...(record.time !== undefined ? { time: localTime(record.time) } : {}),
				...(record.stageMinutes ? { stage_minutes: record.stageMinutes } : {}),
				...(record.title ? { title: record.title } : {}),
				...(record.type !== undefined ? { exercise_type: record.type } : {}),
				...(record.kg !== undefined ? { kg: record.kg } : {}),
			})),
		};
		if (records.length === 0) return { ...text(none), structuredOutput };
		const lines = records.map((record) => {
			if (args.metric === "weight") return `${localTime(record.time ?? 0)}: ${record.kg?.toFixed(1)} kg`;
			const span = `${localTime(record.start ?? 0)} – ${localTime(record.end ?? 0)} (${duration((record.end ?? 0) - (record.start ?? 0))})`;
			if (args.metric === "sleep") {
				const stages = Object.entries(record.stageMinutes ?? {})
					.map(([stage, minutes]) => `${stage} ${minutes}m`)
					.join(", ");
				return `${span}${stages ? ` · ${stages}` : ""}`;
			}
			return `${span} · ${record.title ?? `exercise type ${record.type}`}`;
		});
		return { ...text(lines.join("\n")), structuredOutput };
	},
});

export const HealthExtension = defineExtension({ name: "health", tools: [health] });
