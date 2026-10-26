import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { codeNote, isCodeNote } from "./codes.ts";
import { ocr } from "../scanner-plugin.ts";
import { idbStore } from "../idb.ts";
import { orLogged } from "../promise.ts";
import { Database } from "../database-plugin.ts";

const KINDS = ["pdf", "docx", "sheet", "text"] as const;
export type AttachmentKind = (typeof KINDS)[number];

const EXTENSIONS: Record<string, AttachmentKind> = {
	pdf: "pdf",
	docx: "docx",
	xlsx: "sheet",
	csv: "sheet",
	tsv: "sheet",
	txt: "text",
	md: "text",
	markdown: "text",
	json: "text",
	html: "text",
	htm: "text",
	xml: "text",
	log: "text",
	yaml: "text",
	yml: "text",
};

export const ATTACHMENT_ACCEPT = [...Object.keys(EXTENSIONS).map((ext) => `.${ext}`), "application/pdf", "text/*"].join(",");

export const MAX_IMAGE_EDGE = 1600;

export function jpegOf(canvas: HTMLCanvasElement): ImageContent {
	const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
	return { type: "image", mimeType: "image/jpeg", data: dataUrl.slice(dataUrl.indexOf(",") + 1) };
}

export const unsupportedFile = (name: string) => `不支援這種檔案：${name}（可以傳 PDF、Word、Excel、CSV 和純文字）`;

export function attachmentKind(file: { name: string; type: string }): AttachmentKind | undefined {
	const ext = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
	if (ext && EXTENSIONS[ext]) return EXTENSIONS[ext];
	if (file.type === "application/pdf") return "pdf";
	if (file.type.startsWith("text/")) return "text";
	return undefined;
}

const INLINE_TOKENS = 20_000;
const PREVIEW_TOKENS = 2_000;
const INLINE_PAGE_IMAGES = 4;

export const normalizeCjk = (text: string) => text.replace(/[\u2E80-\u2FDF\uF900-\uFAFF]/g, (char) => char.normalize("NFKC"));

export function estimateTokens(text: string): number {
	const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
	return Math.ceil(cjk + (text.length - cjk) / 4);
}

interface StoredAttachment {
	id: string;
	conversationId: string;
	name: string;
	kind: AttachmentKind;
	size: number;
	createdAt: number;
	units: string[];
	blankPages?: number[];
	ocrPages?: number[];
	tables?: { name: string; sheet: string; rows: number; columns: string[] }[];
	blob?: Blob;
}

const files = idbStore("pi-attachments", "files", { keyPath: "id" });

function isStored(value: unknown): value is StoredAttachment {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "id") === "string" && Array.isArray(Reflect.get(value, "units"));
}

export async function loadAttachment(id: string): Promise<StoredAttachment | undefined> {
	const value: unknown = await files.request("readonly", (store) => store.get(id));
	return isStored(value) ? value : undefined;
}

export async function deleteAttachments(which: { id: string } | { conversationId: string }): Promise<void> {
	if ("id" in which) {
		await files.request("readwrite", (store) => store.delete(which.id));
		return;
	}
	await eachStored("readwrite", (attachment, cursor) => {
		if (attachment.conversationId === which.conversationId) cursor.delete();
	});
}

export async function attachmentOwners(): Promise<string[]> {
	const owners = new Set<string>();
	await eachStored("readonly", (attachment) => owners.add(attachment.conversationId));
	return [...owners];
}

function eachStored(mode: IDBTransactionMode, visit: (attachment: StoredAttachment, cursor: IDBCursorWithValue) => void): Promise<void> {
	return files.transaction(mode, (store) => {
		const request = store.openCursor();
		request.onsuccess = () => {
			const cursor = request.result;
			if (!cursor) return;
			if (isStored(cursor.value)) visit(cursor.value, cursor);
			cursor.continue();
		};
	});
}

export function fullText(attachment: Pick<StoredAttachment, "kind" | "units">): string {
	if (attachment.kind !== "pdf") return attachment.units[0] ?? "";
	return attachment.units.map((page, index) => `--- page ${index + 1} ---\n${page}`).join("\n\n");
}

const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const unescape = (value: string) => value.replace(/&lt;/g, "<").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

function head(text: string, tokens: number): { text: string; lines: number; total: number } {
	const lines = text.split("\n");
	let used = 0;
	let count = 0;
	for (const line of lines) {
		used += estimateTokens(line) + 1;
		if (used > tokens && count > 0) break;
		count++;
	}
	return { text: lines.slice(0, count).join("\n"), lines: count, total: lines.length };
}

function formatAttachment(attachment: StoredAttachment): TextContent {
	const text = fullText(attachment);
	const tokens = estimateTokens(text);
	const attributes: Record<string, string> = {
		id: attachment.id,
		name: attachment.name,
		type: attachment.kind,
		size: String(attachment.size),
		tokens: String(tokens),
	};
	if (attachment.kind === "pdf") attributes.pages = String(attachment.units.length);
	const notes: string[] = [];
	for (const table of attachment.tables ?? []) {
		notes.push(`Imported into the database as table "${table.name}" (sheet ${table.sheet}, ${table.rows} rows; columns: ${table.columns.join(", ")}). Compute over it with sql rather than reading rows.`);
	}
	if (attachment.ocrPages?.length) {
		notes.push(`Pages ${attachment.ocrPages.join(", ")} are scans; their text was read by OCR on the phone and may have errors. See a page itself with read_attachment pages and images=true.`);
	}
	const imageOnly = (attachment.blankPages ?? []).filter((page) => !attachment.ocrPages?.includes(page));
	if (imageOnly.length) {
		const shown = imageOnly.slice(0, INLINE_PAGE_IMAGES);
		notes.push(
			`Pages ${imageOnly.join(", ")} have no text, even by OCR (pictures, or handwriting).${shown.length ? ` Pages ${shown.join(", ")} are attached as images below.` : ""}${imageOnly.length > shown.length ? ` See the others with read_attachment images=true.` : ""}`,
		);
	}
	let body = text;
	if (tokens > INLINE_TOKENS) {
		const preview = head(text, PREVIEW_TOKENS);
		attributes.shown = `lines 1-${preview.lines} of ${preview.total}`;
		body = preview.text;
		notes.push(
			`Only the start is shown. Read on with read_attachment id="${attachment.id}" offset=${preview.lines + 1}${attachment.kind === "pdf" ? ", or pages=\"N-M\"" : ""}, or search it with query.`,
		);
	}
	const open = `<attachment ${Object.entries(attributes)
		.map(([key, value]) => `${key}="${escape(value)}"`)
		.join(" ")}>`;
	return { type: "text", text: [open, ...notes.map((note) => `[${note}]`), body, "</attachment>"].join("\n") };
}

export interface AttachmentCard {
	id: string;
	name: string;
	kind: AttachmentKind;
	size: number;
	pages?: number;
}

const OPEN_TAG = /^<attachment ([^>]*)>/;

export function parseAttachment(text: string): AttachmentCard | undefined {
	const match = OPEN_TAG.exec(text);
	if (!match) return undefined;
	const attributes = Object.fromEntries([...match[1].matchAll(/(\w+)="([^"]*)"/g)].map(([, key, value]) => [key, unescape(value)]));
	const kind = KINDS.find((candidate) => candidate === attributes.type);
	if (!attributes.id || !attributes.name || !kind) return undefined;
	return { id: attributes.id, name: attributes.name, kind, size: Number(attributes.size) || 0, ...(attributes.pages ? { pages: Number(attributes.pages) } : {}) };
}

export function withoutAttachments<T extends { type: string; text?: string }>(content: readonly T[]): T[] {
	return content.filter((block) => block.type !== "text" || !block.text || (!OPEN_TAG.test(block.text) && !isCodeNote(block.text)));
}

export interface PreparedAttachment {
	card: AttachmentCard;
	content: (TextContent | ImageContent)[];
	tables: string[];
}

export async function prepareAttachment(file: File, conversationId: string): Promise<PreparedAttachment> {
	const kind = attachmentKind(file);
	if (!kind) throw new Error(unsupportedFile(file.name));
	const base = { id: `att_${crypto.randomUUID().slice(0, 8)}`, conversationId, name: file.name, kind, size: file.size, createdAt: Date.now() };
	let stored: StoredAttachment;
	let images: (ImageContent | TextContent)[] = [];
	switch (kind) {
		case "pdf": {
			const pdf = await import("./attachments-pdf.ts");
			const { units, blankPages } = await pdf.extractPdf(file);
			const ocrPages: number[] = [];
			const imageOnly: ImageContent[] = [];
			const scans: { page: number; image: ImageContent }[] = [];
			const rendered = await pdf.renderPages(file, blankPages);
			for (const [index, page] of blankPages.entries()) {
				const image = rendered[index];
				if (!image) continue;
				scans.push({ page, image });
				const read = await orLogged(ocr(image.data), "attachments.ocr_failed", "", { page: String(page) });
				if (read.replace(/\s/g, "").length >= 20) {
					units[page - 1] = read;
					ocrPages.push(page);
				} else if (imageOnly.length < INLINE_PAGE_IMAGES) {
					imageOnly.push(image);
				}
			}
			stored = { ...base, units, ...(blankPages.length ? { blankPages } : {}), ...(ocrPages.length ? { ocrPages } : {}), blob: file };
			const codes = await codeNote(
				scans.map((scan) => scan.image),
				(index) => `${file.name} page ${scans[index]?.page}`,
			);
			images = codes ? [...imageOnly, codes] : imageOnly;
			break;
		}
		case "docx": {
			const { extractDocx } = await import("./attachments-docx.ts");
			stored = { ...base, units: [await extractDocx(file)] };
			break;
		}
		case "sheet": {
			const { extractSheet } = await import("./attachments-sheet.ts");
			const { text, tables } = await extractSheet(file);
			stored = { ...base, units: [text], ...(tables.length ? { tables } : {}) };
			break;
		}
		case "text":
			stored = { ...base, units: [(await file.text()).replace(/^\uFEFF/, "")] };
			break;
	}
	await files.request("readwrite", (store) => store.put(stored));
	const card: AttachmentCard = { id: stored.id, name: stored.name, kind, size: stored.size, ...(kind === "pdf" ? { pages: stored.units.length } : {}) };
	return { card, content: [formatAttachment(stored), ...images], tables: (stored.tables ?? []).map((table) => table.name) };
}

export function discardAttachment(prepared: PreparedAttachment): void {
	void deleteAttachments({ id: prepared.card.id });
	if (prepared.tables.length > 0) {
		void Database.execute({ statements: prepared.tables.map((table) => ({ sql: `DROP TABLE IF EXISTS "${table.replace(/"/g, '""')}"` })) });
	}
}
