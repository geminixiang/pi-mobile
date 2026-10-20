// Haptic feedback through the Android system (SystemPlugin.haptic): ticks for a dial's detents, a press when a long
// press takes effect. Nothing off the phone.
import { Capacitor, registerPlugin } from "@capacitor/core";

const System = registerPlugin<{ haptic(options: { kind: "tick" | "press" | "confirm" }): Promise<void> }>("System");

export function haptic(kind: "tick" | "press" | "confirm"): void {
	if (Capacitor.isNativePlatform()) void System.haptic({ kind }).catch(() => undefined);
}
