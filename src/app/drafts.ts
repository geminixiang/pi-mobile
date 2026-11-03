import { type Static, Type } from "typebox";
import { KINDS } from "../agent/attachments.ts";
import { check, oneOf } from "../agent/parse.ts";
import { idbStore } from "../idb.ts";
import { log } from "../log.ts";
import { settled } from "../promise.ts";

const textKey = (conversationId: string) => `pi-mobile.draft:${conversationId}`;

export function loadDraftText(conversationId: string): string {
	return localStorage.getItem(textKey(conversationId)) ?? "";
}

export function saveDraftText(conversationId: string, text: string): void {
	if (text) localStorage.setItem(textKey(conversationId), text);
	else localStorage.removeItem(textKey(conversationId));
}

const Image = Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() });
const DraftAttachments = Type.Object({
	images: Type.Array(Image),
	files: Type.Array(
		Type.Object({
			card: Type.Object({ id: Type.String(), name: Type.String(), kind: oneOf(KINDS), size: Type.Number(), pages: Type.Optional(Type.Number()) }),
			content: Type.Array(Type.Union([Type.Object({ type: Type.Literal("text"), text: Type.String(), textSignature: Type.Optional(Type.String()) }), Image])),
			tables: Type.Array(Type.String()),
		}),
	),
});
type DraftAttachments = Static<typeof DraftAttachments>;

const store = idbStore("pi-drafts", "attachments");

export async function loadDraftAttachments(conversationId: string): Promise<DraftAttachments | undefined> {
	const value: unknown = await store.request("readonly", (files) => files.get(conversationId));
	if (value === undefined) return undefined;
	const checked = check(DraftAttachments, value, "草稿附件");
	if (checked.ok) return checked.value;
	log.warn("draft.unreadable", { conversation: conversationId, problem: checked.problem });
	return undefined;
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

const openComposers = new Map<string, (addition: DraftAttachments) => void>();

export function receiveDraftAdditions(conversationId: string, receive: (addition: DraftAttachments) => void): () => void {
	openComposers.set(conversationId, receive);
	return () => {
		if (openComposers.get(conversationId) === receive) openComposers.delete(conversationId);
	};
}

export function addToDraft(conversationId: string, addition: DraftAttachments): Promise<void> {
	const receive = openComposers.get(conversationId);
	if (receive) {
		receive(addition);
		return Promise.resolve();
	}
	return inOrder(conversationId, async () => {
		const saved = await loadDraftAttachments(conversationId);
		await writeDraftAttachments(conversationId, { images: [...(saved?.images ?? []), ...addition.images], files: [...(saved?.files ?? []), ...addition.files] });
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
