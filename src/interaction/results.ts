import type { Context } from "@earendil-works/chord";
import { defineDoc, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { checkpointEvery64 } from "../agent/doc-policy.ts";
import { stepOf } from "./forms.ts";

export type WeatherHour = { time: string; condition: string; temperature_c: number; rain_chance: number };
export type WeatherDay = { date: string; weekday: string; condition: string; low_c: number; high_c: number; rain_chance: number };

export type WeatherResult = {
	kind: "weather";
	step: string;
	place: string;
	at: number;
	now: { condition: string; temperature_c: number; feels_c: number };
	hours: WeatherHour[];
	days: WeatherDay[];
};

export type AlertResult = { kind: "alert"; step: string; at: number; quote: string };

export type ResultCard = WeatherResult | AlertResult;

const KEPT = 20;
const HOURS_SHOWN = 12;
const DAYS_SHOWN = 7;
const QUOTE_CHARS = 160;

export const ResultsDoc = defineDoc<{ cards: ResultCard[] }>({
	kind: "app.interaction.results",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ cards: [] }),
	checkpointWhen: checkpointEvery64,
});

export function addResult(cards: ResultCard[], card: ResultCard): void {
	const same = cards.findIndex((kept) => kept.step === card.step && kept.kind === card.kind && (kept.kind !== "weather" || card.kind !== "weather" || kept.place === card.place));
	if (same >= 0) cards.splice(same, 1);
	cards.push(card);
	if (cards.length > KEPT) cards.splice(0, cards.length - KEPT);
}

export function showWeather(api: ToolExecutionApi, context: Context, weather: Pick<WeatherResult, "place" | "now" | "hours" | "days">): Promise<void> {
	const card: WeatherResult = {
		...weather,
		kind: "weather",
		step: stepOf(api.callId),
		at: api.now(),
		hours: weather.hours.slice(0, HOURS_SHOWN),
		days: weather.days.slice(0, DAYS_SHOWN),
	};
	return api.commit(async (tx) => addResult((await tx.doc(ResultsDoc, api.conversationId)).cards, card), context);
}

export function showAlert(api: ToolExecutionApi, context: Context, text: string): Promise<void> {
	const card: AlertResult = { kind: "alert", step: stepOf(api.callId), at: api.now(), quote: text.trim().slice(-QUOTE_CHARS) };
	return api.commit(async (tx) => addResult((await tx.doc(ResultsDoc, api.conversationId)).cards, card), context);
}
