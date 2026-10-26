import type { ImageContent } from "@earendil-works/pi-ai";
import type { PreparedAttachment } from "../agent/attachments.ts";
import { idbStore } from "../idb.ts";
import { settled } from "../promise.ts";

const textKey = (conversationId: string) => `pi-mobile.draft:${conversationId}`;

export function loadDraftText(conversationId: string): string {
	return localStorage.getItem(textKey(conversationId)) ?? "";
}

export function saveDraftText(conversationId: string, text: string): void {
	if (text) localStorage.setItem(textKey(conversationId), text);
	else localStorage.removeItem(textKey(conversationId));
}

type DraftAttachments = { images: ImageContent[]; files: PreparedAttachment[] };

const store = idbStore("pi-drafts", "attachments");

function isDraftAttachments(value: unknown): value is DraftAttachments {
	return typeof value === "object" && value !== null && Array.isArray(Reflect.get(value, "images")) && Array.isArray(Reflect.get(value, "files"));
}

export async function loadDraftAttachments(conversationId: string): Promise<DraftAttachments | undefined> {
	const value: unknown = await store.request("readonly", (files) => files.get(conversationId));
	return isDraftAttachments(value) ? value : undefined;
}

async function writeDraftAttachments(conversationId: string, draft: DraftAttachments): Promise<void> {
	if (draft.images.length + draft.files.length > 0) await store.request("readwrite", (files) => files.put(draft, conversationId));
	else await store.request("readwrite", (files) => files.delete(conversationId));
}

const draftWrites = new Map<string, Promise<void>>();

function inOrder(conversationId: string, write: () => Promise<void>): Promise<void> {
	const done = (draftWrites.get(conversationId) ?? Promise.resolve()).then(write);
	draftWrites.set(conversationId, settled(done));
	return done;
}

export function saveDraftAttachments(conversationId: string, draft: DraftAttachments): Promise<void> {
	return inOrder(conversationId, () => writeDraftAttachments(conversationId, draft));
}

const openComposers = new Map<string, (file: PreparedAttachment) => void>();

export function receiveDraftFiles(conversationId: string, receive: (file: PreparedAttachment) => void): () => void {
	openComposers.set(conversationId, receive);
	return () => {
		if (openComposers.get(conversationId) === receive) openComposers.delete(conversationId);
	};
}

export function addDraftFile(conversationId: string, file: PreparedAttachment): Promise<void> {
	const receive = openComposers.get(conversationId);
	if (receive) {
		receive(file);
		return Promise.resolve();
	}
	return inOrder(conversationId, async () => {
		const saved = await loadDraftAttachments(conversationId);
		await writeDraftAttachments(conversationId, { images: saved?.images ?? [], files: [...(saved?.files ?? []), file] });
	});
}

export async function draftOwners(): Promise<string[]> {
	const owners = new Set<string>();
	for (const key of Object.keys(localStorage)) if (key.startsWith(textKey(""))) owners.add(key.slice(textKey("").length));
	const keys = await store.request("readonly", (files) => files.getAllKeys());
	for (const key of keys) if (typeof key === "string") owners.add(key);
	return [...owners];
}

export async function clearDraft(conversationId: string): Promise<void> {
	saveDraftText(conversationId, "");
	await saveDraftAttachments(conversationId, { images: [], files: [] });
}
