import { pad } from "../agent/tools/common.ts";
import type { TriggerSymbol } from "../app/icons.tsx";
import type { ACTIVITIES, When } from "./plugin.ts";

const ACTIVITY_NAMES: Record<(typeof ACTIVITIES)[number], [string, string]> = {
	walking: ["開始走路", "停止走路"],
	running: ["開始跑步", "停止跑步"],
	cycling: ["開始騎車", "停止騎車"],
	vehicle: ["上車", "下車"],
	still: ["靜止下來", "開始移動"],
};

const KINDS: Record<When["kind"], true> = {
	daily: true,
	once: true,
	headphones: true,
	charging: true,
	wifi: true,
	notification: true,
	place: true,
	unlock: true,
	battery_low: true,
	timezone: true,
	photo: true,
	bluetooth: true,
	activity: true,
};

const WEEKDAY_NAMES = ["一", "二", "三", "四", "五", "六", "日"];

export type EventWhen = Exclude<When, { kind: "once" | "daily" }>;

export const isEvent = (when: When): when is EventWhen => when.kind !== "once" && when.kind !== "daily";

export function isWhenKind(value: string): value is When["kind"] {
	return Object.hasOwn(KINDS, value);
}

export function describeTime(at: number): string {
	const date = new Date(at);
	return `${date.getMonth() + 1}/${date.getDate()}（${WEEKDAY_NAMES[(date.getDay() + 6) % 7]}）${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function describeWhen(when: When): string {
	if (when.kind === "once") return describeTime(when.at);
	if (when.kind === "daily") return `${describeDays(when.days)} ${when.time}`;
	const window = when.from || when.until ? ` ${when.from ?? "00:00"}–${when.until ?? "24:00"}` : "";
	const days = describeDays(when.days);
	const limit = when.gapHours >= 24 ? "一天一次" : `最多每 ${when.gapHours} 小時一次`;
	return `${days === "每天" ? "" : days}${window} ${describeEvent(when)}（${limit}）`.trim();
}

function describeDays(list: readonly number[]): string {
	const days = [...list].sort();
	if (days.length === 0 || days.length === 7) return "每天";
	if (days.join() === "1,2,3,4,5") return "平日";
	if (days.join() === "6,7") return "週末";
	return `每週${days.map((day) => WEEKDAY_NAMES[day - 1]).join("、")}`;
}

function describeEvent(when: EventWhen): string {
	switch (when.kind) {
		case "headphones":
			return "戴上耳機時";
		case "charging":
			return "開始充電時";
		case "wifi":
			return `連上 ${when.ssid ? `Wi‑Fi「${when.ssid}」` : "Wi‑Fi"}時`;
		case "notification":
			return `收到${when.app ? ` ${when.app} ` : ""}${when.contains ? `含「${when.contains}」的` : ""}通知時`;
		case "place":
			return `${when.on === "arrive" ? "到達" : "離開"}${when.label}時`;
		case "unlock":
			return "解鎖手機時";
		case "battery_low":
			return "電量低時";
		case "timezone":
			return "換時區時";
		case "photo":
			return `拍了新照片${when.album ? `（${when.album}）` : ""}時`;
		case "bluetooth":
			return `${when.on === "connect" ? "連上" : "斷開"}藍牙「${when.device}」時`;
		case "activity":
			return `${ACTIVITY_NAMES[when.activity][when.on === "start" ? 0 : 1]}時`;
	}
}

export function triggerSymbol(when: Pick<When, "kind"> & { activity?: string }): TriggerSymbol {
	switch (when.kind) {
		case "daily":
		case "once":
			return "clock";
		case "headphones":
			return "headphones";
		case "notification":
			return "bell";
		case "place":
			return "pin";
		case "wifi":
			return "wifi";
		case "charging":
			return "charging";
		case "battery_low":
			return "battery";
		case "unlock":
			return "unlock";
		case "photo":
			return "image";
		case "timezone":
			return "globe";
		case "bluetooth":
			return "bluetooth";
		case "activity":
			return when.activity === "vehicle" ? "car" : when.activity === "cycling" ? "bike" : when.activity === "still" ? "still" : "walk";
	}
}
