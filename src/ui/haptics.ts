import { type Haptic, platform } from "./platform.ts";

export const HOLD_MS = 380;
export const HOLD_SLOP = 10;

export function haptic(kind: Haptic): void {
	platform().haptic(kind);
}

export function longPress(act: () => void): (event: { preventDefault(): void }) => void {
	return (event) => {
		event.preventDefault();
		haptic("press");
		act();
	};
}
