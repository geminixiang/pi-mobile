import { native } from "../native.ts";
import { System } from "../plugins/system.ts";
import { orLogged } from "../promise.ts";

export const HOLD_MS = 380;
export const HOLD_SLOP = 10;

export function haptic(kind: "tick" | "press" | "confirm"): void {
	if (native.has("System")) void orLogged(System.haptic({ kind }), "haptics.failed", undefined);
}

export function longPress(act: () => void): (event: { preventDefault(): void }) => void {
	return (event) => {
		event.preventDefault();
		haptic("press");
		act();
	};
}
