import type { EntryRecord } from "@earendil-works/pi-durable";
import { isWrite, toolCalls } from "../agent/entries.ts";
import { baseName, isHtml } from "../agent/mime.ts";

export type Page = { path: string; title: string; summary: string; html?: string };

const TITLE = /<title[^>]*>([^<]*)<\/title>/i;
const DESCRIPTION = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i;
const FIRST_PARAGRAPH = /<p[^>]*>([^<]+)/i;

export function pageCards(entries: readonly EntryRecord[], succeeded: (callId: string) => boolean): ReadonlyMap<string, Page> {
	const latest = new Map<string, { callId: string; page: Page }>();
	for (const entry of entries) {
		for (const block of toolCalls(entry)) {
			const path = block.arguments.path;
			if (!isWrite(block) || typeof path !== "string" || !isHtml(path) || !succeeded(block.id)) continue;
			const content = typeof block.arguments.content === "string" ? block.arguments.content : "";
			const before = latest.get(path)?.page;
			const title = TITLE.exec(content)?.[1]?.trim() || before?.title || baseName(path);
			const summary = (DESCRIPTION.exec(content)?.[1] ?? FIRST_PARAGRAPH.exec(content)?.[1] ?? "").trim() || (before?.summary ?? "");
			latest.set(path, { callId: block.id, page: { path, title, summary, ...(content ? { html: content } : {}) } });
		}
	}
	return new Map([...latest.values()].map(({ callId, page }) => [callId, page]));
}
