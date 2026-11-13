import type { TextContent } from "@earendil-works/pi-ai";

const OPEN = "<in-view>\n";
const CLOSE = "\n</in-view>";

export function inViewNote(path: string): TextContent {
	return { type: "text", text: `${OPEN}${path}${CLOSE}\nThe user had this file open beside the chat while writing; "this" or "it" likely means it.` };
}

export function inViewPath(text: string): string | undefined {
	if (!text.startsWith(OPEN)) return undefined;
	const end = text.indexOf(CLOSE, OPEN.length);
	return end === -1 ? undefined : text.slice(OPEN.length, end);
}
