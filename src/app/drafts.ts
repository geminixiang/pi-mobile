// What the user has written for a bot but not sent, kept on the phone so it survives switching bots and Android
// ending pi in the background. The text in localStorage, read synchronously so a conversation opens with it; the
// photos and read files in IndexedDB, as they can be megabytes. Both go when sent or cleared.
import type { ImageContent } from "@earendil-works/pi-ai";
import type { PreparedAttachment } from "../agent/attachments.ts";
import { idbStore } from "../idb.ts";

const textKey = (conversationId: string) => `pi-mobile.draft:${conversationId}`;

export function loadDraftText(conversationId: string): string {
	return localStorage.getItem(textKey(conversationId)) ?? "";
}

export function saveDraftText(conversationId: string, text: string): void {
	if (text) localStorage.setItem(textKey(conversationId), text);
	else localStorage.removeItem(textKey(conversationId));
}

/** Photos and files picked for the next message; files only once read. */
export type DraftAttachments = { images: ImageContent[]; files: PreparedAttachment[] };

const store = idbStore("pi-drafts", "attachments");

function isDraftAttachments(value: unknown): value is DraftAttachments {
	return typeof value === "object" && value !== null && Array.isArray(Reflect.get(value, "images")) && Array.isArray(Reflect.get(value, "files"));
}

export async function loadDraftAttachments(conversationId: string): Promise<DraftAttachments | undefined> {
	const value: unknown = await store.request("readonly", (files) => files.get(conversationId));
	return isDraftAttachments(value) ? value : undefined;
}

export async function saveDraftAttachments(conversationId: string, draft: DraftAttachments): Promise<void> {
	if (draft.images.length + draft.files.length > 0) await store.request("readwrite", (files) => files.put(draft, conversationId));
	else await store.request("readwrite", (files) => files.delete(conversationId));
}

/** A deleted bot's draft. */
export async function clearDraft(conversationId: string): Promise<void> {
	saveDraftText(conversationId, "");
	await saveDraftAttachments(conversationId, { images: [], files: [] });
}
