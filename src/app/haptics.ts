import { native } from "../native.ts";
import { System } from "../plugins/system.ts";
import { orLogged } from "../promise.ts";

export function haptic(kind: "tick" | "press" | "confirm"): void {
	if (native.has("System")) void orLogged(System.haptic({ kind }), "haptics.failed", undefined);
}
