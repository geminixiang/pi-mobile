import { Capacitor } from "@capacitor/core";
import { System } from "../system-plugin.ts";
import { orLogged } from "../promise.ts";

export function haptic(kind: "tick" | "press" | "confirm"): void {
	if (Capacitor.isNativePlatform()) void orLogged(System.haptic({ kind }), "haptics.failed", undefined);
}
