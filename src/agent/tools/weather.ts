// weather: the forecast for a place, or where the phone is, from Open-Meteo (free, no key; national weather models,
// for Taiwan JMA's and ECMWF's among them). Current conditions, the hours ahead, and the days ahead, so 「等等會下雨嗎」
// and 「週六宜蘭要帶傘嗎」 get numbers instead of a guess.
import { Type } from "typebox";
import { defineExtension } from "@earendil-works/pi-durable";
import { defineAppTool } from "./common.ts";
import { parse } from "../parse.ts";
import { currentPlace, type Point, resolvePlace } from "./device.ts";

/** WMO weather interpretation codes, as Open-Meteo reports them. */
const CONDITIONS: Record<number, string> = {
	0: "晴",
	1: "大致晴朗",
	2: "多雲",
	3: "陰",
	45: "霧",
	48: "霧凇",
	51: "毛毛雨",
	53: "毛毛雨",
	55: "濃毛毛雨",
	56: "凍毛毛雨",
	57: "凍毛毛雨",
	61: "小雨",
	63: "中雨",
	65: "大雨",
	66: "凍雨",
	67: "凍雨",
	71: "小雪",
	73: "中雪",
	75: "大雪",
	77: "冰珠",
	80: "陣雨",
	81: "較強陣雨",
	82: "豪大陣雨",
	85: "陣雪",
	86: "較強陣雪",
	95: "雷雨",
	96: "雷雨伴冰雹",
	99: "強雷雨伴冰雹",
};

const condition = (code: number) => CONDITIONS[code] ?? `代碼 ${code}`;

const Numbers = Type.Array(Type.Union([Type.Number(), Type.Null()]));
const Forecast = Type.Object({
	timezone: Type.String(),
	current: Type.Object({
		time: Type.String(),
		temperature_2m: Type.Number(),
		apparent_temperature: Type.Number(),
		relative_humidity_2m: Type.Number(),
		precipitation: Type.Number(),
		weather_code: Type.Number(),
		wind_speed_10m: Type.Number(),
	}),
	hourly: Type.Object({
		time: Type.Array(Type.String()),
		temperature_2m: Numbers,
		precipitation_probability: Numbers,
		precipitation: Numbers,
		weather_code: Numbers,
	}),
	daily: Type.Object({
		time: Type.Array(Type.String()),
		weather_code: Numbers,
		temperature_2m_max: Numbers,
		temperature_2m_min: Numbers,
		precipitation_probability_max: Numbers,
		precipitation_sum: Numbers,
		uv_index_max: Numbers,
		sunrise: Type.Array(Type.String()),
		sunset: Type.Array(Type.String()),
	}),
});

const Hour = Type.Object({ time: Type.String(), condition: Type.String(), temperature_c: Type.Number(), rain_chance: Type.Number(), rain_mm: Type.Number() });
const Day = Type.Object({
	date: Type.String(),
	condition: Type.String(),
	low_c: Type.Number(),
	high_c: Type.Number(),
	rain_chance: Type.Number(),
	rain_mm: Type.Number(),
	uv_index: Type.Number(),
	sunrise: Type.String(),
	sunset: Type.String(),
});

const at = (values: readonly (number | null)[], index: number) => values[index] ?? 0;
const clock = (iso: string) => iso.slice(11, 16);

const weather = defineAppTool({
	name: "weather",
	description:
		"Weather forecast for a place, or where the phone is when no place is given: current conditions, hourly for the hours ahead (temperature, chance of rain, rainfall), and daily for the days ahead (low, high, chance of rain, rainfall, UV, sunrise and sunset). Use it for any question about weather, rain, umbrellas, or what to wear, instead of searching the web.",
	parameters: Type.Object({
		place: Type.Optional(Type.String({ description: "Place name or address (宜蘭、合歡山、東京), or lat,lng; default the phone's location" })),
		hours: Type.Optional(Type.Integer({ minimum: 1, description: "Hours of hourly forecast from now; default 24, up to 384" })),
		days: Type.Optional(Type.Integer({ minimum: 1, description: "Days of daily forecast from today; default 7, up to 16" })),
	}),
	structuredOutputSchema: Type.Object({ place: Type.String(), now: Hour, hours: Type.Array(Hour), days: Type.Array(Day) }),
	replay: "safe",
	execute: async (args, _api, context) => {
		const point: Point = args.place ? await resolvePlace(args.place) : await currentPlace();
		const hours = Math.min(Math.max(args.hours ?? 24, 1), 384);
		const days = Math.min(Math.max(args.days ?? 7, 1), 16);
		const query = new URLSearchParams({
			latitude: String(point.latitude),
			longitude: String(point.longitude),
			current: "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m",
			hourly: "temperature_2m,precipitation_probability,precipitation,weather_code",
			daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,uv_index_max,sunrise,sunset",
			timezone: "auto",
			forecast_hours: String(hours),
			forecast_days: String(days),
		});
		const response = await fetch(`https://api.open-meteo.com/v1/forecast?${query}`, { signal: context.abortSignal });
		if (!response.ok) throw new Error(`weather service: HTTP ${response.status} ${await response.text()}`);
		const body = parse(Forecast, await response.json(), "weather forecast");
		const c = body.current;
		// The hourly series starts at the current hour; its first rain chance stands for now.
		const now = {
			time: c.time.replace("T", " "),
			condition: condition(c.weather_code),
			temperature_c: c.temperature_2m,
			rain_chance: at(body.hourly.precipitation_probability, 0),
			rain_mm: c.precipitation,
		};
		const hourly = body.hourly.time.map((time, i) => ({
			time: time.replace("T", " "),
			condition: condition(at(body.hourly.weather_code, i)),
			temperature_c: at(body.hourly.temperature_2m, i),
			rain_chance: at(body.hourly.precipitation_probability, i),
			rain_mm: at(body.hourly.precipitation, i),
		}));
		const d = body.daily;
		const daily = d.time.map((date, i) => ({
			date,
			condition: condition(at(d.weather_code, i)),
			low_c: at(d.temperature_2m_min, i),
			high_c: at(d.temperature_2m_max, i),
			rain_chance: at(d.precipitation_probability_max, i),
			rain_mm: at(d.precipitation_sum, i),
			uv_index: at(d.uv_index_max, i),
			sunrise: clock(d.sunrise[i] ?? ""),
			sunset: clock(d.sunset[i] ?? ""),
		}));
		const text = [
			`${point.label} (${body.timezone})`,
			`Now ${now.time}: ${now.condition} ${c.temperature_2m}°C, feels ${c.apparent_temperature}°C, humidity ${c.relative_humidity_2m}%, wind ${c.wind_speed_10m} km/h, rain ${c.precipitation} mm`,
			"",
			"Hourly (time condition temp rain-chance rainfall):",
			...hourly.map((h) => `${h.time} ${h.condition} ${h.temperature_c}°C ${h.rain_chance}% ${h.rain_mm}mm`),
			"",
			"Daily (date condition low–high rain-chance rainfall UV sunrise–sunset):",
			...daily.map((day) => `${day.date} ${day.condition} ${day.low_c}–${day.high_c}°C ${day.rain_chance}% ${day.rain_mm}mm UV ${day.uv_index} ${day.sunrise}–${day.sunset}`),
		].join("\n");
		return { output: [{ type: "text", text }], structuredOutput: { place: point.label, now, hours: hourly, days: daily } };
	},
});

export const WeatherExtension = defineExtension({
	name: "weather",
	tools: [weather],
});
