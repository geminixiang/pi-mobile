import type { TextContent } from "@earendil-works/pi-ai";

const OPEN = "<in-view>\n";
const CLOSE = "\n</in-view>";
const PART_OPEN = "\n<part>\n";
const PART_CLOSE = "\n</part>";

export function inViewNote(path: string, part?: string): TextContent {
	const pointed = part ? `${PART_OPEN}${part}${PART_CLOSE}` : "";
	const meaning = part ? 'They pointed at the part above; "this" or "it" likely means that part, so change only it unless they say otherwise.' : 'The user had this file open beside the chat while writing; "this" or "it" likely means it.';
	return { type: "text", text: `${OPEN}${path}${CLOSE}${pointed}\n${meaning}` };
}

export function inViewPath(text: string): string | undefined {
	if (!text.startsWith(OPEN)) return undefined;
	const end = text.indexOf(CLOSE, OPEN.length);
	return end === -1 ? undefined : text.slice(OPEN.length, end);
}

export function inViewPart(text: string): string | undefined {
	const path = inViewPath(text);
	if (path === undefined) return undefined;
	const start = OPEN.length + path.length + CLOSE.length;
	if (!text.startsWith(PART_OPEN, start)) return undefined;
	const end = text.indexOf(PART_CLOSE, start + PART_OPEN.length);
	return end === -1 ? undefined : text.slice(start + PART_OPEN.length, end);
}
