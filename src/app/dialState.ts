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

export type Repeating = "older" | "newer";

export function repeatingOf(dial: DialState | undefined): Repeating | undefined {
	if (!dial) return undefined;
	if (dial.slot === dial.slots) return "older";
	if (dial.slot === -1) return "newer";
	return undefined;
}

export function positionOf(dial: DialState, count: number, slot = dial.slot): number {
	return count - dial.shift - Math.max(0, Math.min(dial.slots - 1, slot));
}

export function turned(dial: DialState, toward: Repeating, count: number): DialState {
	const shift = toward === "older" ? dial.shift + 1 : dial.shift - 1;
	const older = positionOf({ ...dial, shift }, count, dial.slots - 1);
	if (shift < 0 || older < 0) return dial;
	if (toward === "older" && older === 0) return { ...dial, shift, slot: dial.slots - 1 };
	if (toward === "newer" && shift === 0) return { ...dial, shift, slot: 0 };
	return { ...dial, shift };
}
