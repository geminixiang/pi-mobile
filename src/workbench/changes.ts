export const BLOCKS = "h1, h2, h3, h4, p, li, tr, blockquote, pre, dt, dd";

const MOST_CELLS = 4_000_000;
const PART_CHARS = 14;

export const linesOf = (text: string): string[] => text.replace(/\n$/, "").split("\n");

export const squeezed = (text: string): string => text.replace(/\s+/g, " ").trim();

export function changed(before: readonly string[], after: readonly string[]): ReadonlySet<number> {
	if (before.length * after.length > MOST_CELLS) {
		const old = new Set(before);
		return new Set(after.flatMap((item, index) => (old.has(item) ? [] : [index])));
	}
	const width = after.length + 1;
	const common = new Uint32Array((before.length + 1) * width);
	for (let i = before.length - 1; i >= 0; i--) {
		for (let j = after.length - 1; j >= 0; j--) {
			common[i * width + j] = before[i] === after[j] ? (common[(i + 1) * width + j + 1] ?? 0) + 1 : Math.max(common[(i + 1) * width + j] ?? 0, common[i * width + j + 1] ?? 0);
		}
	}
	const kept = new Set<number>();
	let i = 0;
	let j = 0;
	while (i < before.length && j < after.length) {
		if (before[i] === after[j]) {
			kept.add(j);
			i++;
			j++;
		} else if ((common[(i + 1) * width + j] ?? 0) >= (common[i * width + j + 1] ?? 0)) i++;
		else j++;
	}
	return new Set(after.flatMap((_, index) => (kept.has(index) ? [] : [index])));
}

export function partLabel(part: string): string {
	const short = squeezed(part);
	return `「${short.length > PART_CHARS ? `${short.slice(0, PART_CHARS)}…` : short}」`;
}
