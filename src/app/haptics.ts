// Haptic feedback through the Android system (SystemPlugin.haptic): ticks for a dial's detents, a press when a long
// press takes effect. Nothing off the phone.
import { Capacitor } from "@capacitor/core";
import { System } from "../system-plugin.ts";

export function haptic(kind: "tick" | "press" | "confirm"): void {
	if (Capacitor.isNativePlatform()) void System.haptic({ kind }).catch(() => undefined);
}
