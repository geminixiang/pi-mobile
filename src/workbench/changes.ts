import type { Element as HastElement, Root, RootContent } from "hast";

export const BLOCKS = "h1, h2, h3, h4, p, li, tr, blockquote, pre, dt, dd";
const BLOCK_TAGS = new Set(BLOCKS.split(", "));
const SPACED = new Set([...BLOCK_TAGS, "ul", "ol", "dl", "table", "thead", "tbody", "td", "th", "br", "div", "hr"]);

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

function textOf(node: RootContent): string {
	if (node.type === "text") return node.value;
	if (node.type !== "element") return "";
	const inner = node.children.map(textOf).join("");
	return SPACED.has(node.tagName) ? ` ${inner} ` : inner;
}

export type BlockMarks = { changed: ReadonlySet<number>; picked: string | undefined; parts: string[] };

export function markBlocks(marks: BlockMarks) {
	const mark = (element: HastElement) => {
		if (!BLOCK_TAGS.has(element.tagName)) return;
		const start = element.position?.start.line ?? 0;
		const end = element.position?.end.line ?? -1;
		const part = squeezed(textOf(element));
		const edited = Array.from({ length: end - start + 1 }, (_, index) => start - 1 + index).some((line) => marks.changed.has(line));
		const classes = [...(edited ? ["changed"] : []), ...(part === marks.picked ? ["picked"] : [])];
		element.properties.dataBlock = marks.parts.push(part) - 1;
		if (classes.length > 0) element.properties.className = classes;
	};
	const visit = (node: Root | RootContent) => {
		if (node.type === "element") mark(node);
		if ("children" in node) for (const child of node.children) visit(child);
	};
	return () => (tree: Root) => {
		marks.parts.length = 0;
		visit(tree);
	};
}
