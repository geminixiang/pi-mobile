export interface DialState {
	px: number;
	py: number;
	radius: number;
	start: number;
	step: number;
	slots: number;
	slot: number;
	shift: number;
	lineY: number;
}

export function repeatingOf(dial: DialState | undefined): "older" | "newer" | undefined {
	if (!dial) return undefined;
	if (dial.slot === dial.slots) return "older";
	if (dial.slot === -1) return "newer";
	return undefined;
}
