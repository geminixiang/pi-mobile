// health: the user's Health Connect data, read-only (HealthPlugin.java): steps and average heart rate per day, sleep
// and exercise sessions, weight. Samsung Health, Fitbit, and others write there when their sync is on.
import { Capacitor, registerPlugin } from "@capacitor/core";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

type Metric = "steps" | "heart_rate" | "sleep" | "exercise" | "weight";
interface HealthRecord {
	source: string;
	start?: number;
	end?: number;
	time?: number;
	stageMinutes?: Record<string, number>;
	type?: number;
	title?: string;
	kg?: number;
}

const Health = registerPlugin<{
	read(options: { metric: Metric; days: number }): Promise<{ days?: { day: string; value: number }[]; records?: HealthRecord[] }>;
}>("Health");

const pad = (value: number) => String(value).padStart(2, "0");
const clock = (ms: number) => {
	const d = new Date(ms);
	return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const hours = (ms: number) => `${Math.floor(ms / 3_600_000)} 小時 ${Math.round((ms % 3_600_000) / 60_000)} 分`;

const health = defineTool({
	name: "health",
	description:
		"The user's health data from Health Connect (Samsung Health and other apps sync there): steps or average heart rate per day, sleep sessions with stages, exercise sessions, weight. Use it for 「我這週睡得怎樣」「今天走幾步」.",
	parameters: Type.Object({
		metric: Type.Union([Type.Literal("steps"), Type.Literal("heart_rate"), Type.Literal("sleep"), Type.Literal("exercise"), Type.Literal("weight")]),
		days: Type.Optional(Type.Integer({ minimum: 1, maximum: 90, description: "The last this many days, today included (default 7)" })),
	}),
	execute: async (args) => {
		if (!Capacitor.isNativePlatform()) throw new Error("only available in the Android app");
		const days = args.days || 7;
		const result = await Health.read({ metric: args.metric, days });
		const none = `No ${args.metric.replace("_", " ")} data in Health Connect for the last ${days} days. If the user tracks it in Samsung Health, its Health Connect sync may be off (Samsung Health › 設定 › Health Connect).`;
		if (result.days) {
			if (result.days.length === 0) return { output: [{ type: "text", text: none }] };
			const unit = args.metric === "steps" ? "步" : "bpm";
			return { output: [{ type: "text", text: result.days.map((day) => `${day.day}: ${Math.round(day.value)} ${unit}`).join("\n") }] };
		}
		const records = result.records ?? [];
		if (records.length === 0) return { output: [{ type: "text", text: none }] };
		const lines = records.map((record) => {
			if (args.metric === "weight") return `${clock(record.time ?? 0)}: ${record.kg?.toFixed(1)} kg`;
			const span = `${clock(record.start ?? 0)}–${clock(record.end ?? 0)} (${hours((record.end ?? 0) - (record.start ?? 0))})`;
			if (args.metric === "sleep") {
				const stages = Object.entries(record.stageMinutes ?? {})
					.map(([stage, minutes]) => `${stage} ${minutes}m`)
					.join(", ");
				return `${span}${stages ? ` · ${stages}` : ""}`;
			}
			return `${span} · ${record.title ?? `exercise type ${record.type}`}`;
		});
		return { output: [{ type: "text", text: lines.join("\n") }] };
	},
});

export const HealthExtension = defineExtension({ name: "health", tools: [health] });
