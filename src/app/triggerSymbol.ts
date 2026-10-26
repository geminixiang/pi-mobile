import type { When } from "../plugins/triggers.ts";
import type { TriggerSymbol } from "./icons.tsx";

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

export function isWhenKind(value: string): value is When["kind"] {
	return Object.hasOwn(KINDS, value);
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
