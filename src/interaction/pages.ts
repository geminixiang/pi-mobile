import type { EntryRecord } from "@earendil-works/pi-durable";
import { blocks, message } from "../agent/entries.ts";

export type Page = { path: string; title: string; summary: string; html?: string };

const HTML_FILE = /\.html?$/i;
const TITLE = /<title[^>]*>([^<]*)<\/title>/i;
const DESCRIPTION = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i;
const FIRST_PARAGRAPH = /<p[^>]*>([^<]+)/i;

const nameOf = (path: string) => path.split("/").at(-1) ?? path;

export function pageCards(entries: readonly EntryRecord[], succeeded: (callId: string) => boolean): ReadonlyMap<string, Page> {
	const latest = new Map<string, { callId: string; page: Page }>();
	for (const entry of entries) {
		if (entry.kind !== "pi.assistant") continue;
		for (const block of blocks(message(entry)?.content)) {
			if (block.type !== "toolCall" || (block.name !== "write" && block.name !== "edit")) continue;
			const path = block.arguments.path;
			if (typeof path !== "string" || !HTML_FILE.test(path) || !succeeded(block.id)) continue;
			const content = typeof block.arguments.content === "string" ? block.arguments.content : "";
			const before = latest.get(path)?.page;
			const title = TITLE.exec(content)?.[1]?.trim() || before?.title || nameOf(path);
			const summary = (DESCRIPTION.exec(content)?.[1] ?? FIRST_PARAGRAPH.exec(content)?.[1] ?? "").trim() || (before?.summary ?? "");
			latest.set(path, { callId: block.id, page: { path, title, summary, ...(content ? { html: content } : {}) } });
		}
	}
	return new Map([...latest.values()].map(({ callId, page }) => [callId, page]));
}
