import { contentText, type ImageContent, type Message, type TextContent, type ThinkingContent, type ToolCall } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { withoutAttachments } from "./attachments.ts";

export type Block = TextContent | ThinkingContent | ImageContent | ToolCall;

export function blocks(content: string | readonly Block[] | undefined): readonly Block[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return content ?? [];
}

export function message(entry: EntryRecord): Message | undefined {
	return entry.model?.[0];
}

export function entryText(entry: EntryRecord): string {
	return contentText(withoutAttachments(blocks(message(entry)?.content)));
}
