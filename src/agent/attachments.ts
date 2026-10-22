// Files the user attaches to a message (docs/research/attachments.md): PDF, Word (docx), spreadsheets (xlsx, csv), and
// plain text. pi-ai's messages carry only text and images, so each file becomes text on the phone, as ChatGPT, Claude
// and the open-source apps do, and the original stays in IndexedDB for read_attachment (tools/attachments.ts):
//
// - It fits (INLINE_TOKENS): its whole text goes into the message.
// - It does not: the first PREVIEW_TOKENS of it, and a notice naming the read_attachment call for the rest. A file
//   that big inline would be re-sent with every later request of the conversation.
// - A spreadsheet is also imported into the user's SQLite database, one table a sheet, to compute over with sql.
// - A PDF's pages without text (scans) are rendered as images: in the message for a few, on request for more.
//
// The message text is an <attachment> element (formatAttachment), which the transcript shows as a file card
// (parseAttachment) instead of its text.
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { codeNote, isCodeNote } from "./codes.ts";
import { ocr } from "../scanner-plugin.ts";
import { idbStore } from "../idb.ts";

export type AttachmentKind = "pdf" | "docx" | "sheet" | "text";

/** What the file picker offers and what each extension is. */
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

export function attachmentKind(file: { name: string; type: string }): AttachmentKind | undefined {
	const ext = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
	if (ext && EXTENSIONS[ext]) return EXTENSIONS[ext];
	if (file.type === "application/pdf") return "pdf";
	if (file.type.startsWith("text/")) return "text";
	return undefined;
}

/** Whole text into the message up to this; past it, a preview. About 20k: ChatGPT's 110k is for its long-context models. */
const INLINE_TOKENS = 20_000;
const PREVIEW_TOKENS = 2_000;
/** Scanned pages rendered into the message itself; more are read with read_attachment's images. */
export const INLINE_PAGE_IMAGES = 4;

/**
 * CJK radicals and compatibility ideographs as the ideographs they stand for. PDFs often draw CJK with them, such as
 * the Kangxi radical ⽣ (U+2F63) for 生: they look the same but would not match a search for 生. Only those blocks:
 * NFKC on the whole text would also turn full-width punctuation (，；) into ASCII.
 */
export const normalizeCjk = (text: string) => text.replace(/[\u2E80-\u2FDF\uF900-\uFAFF]/g, (char) => char.normalize("NFKC"));

/**
 * About how many tokens text takes: a CJK character is about one, other text about four characters a token. Close
 * enough to decide inline or preview; it is not a tokenizer.
 */
export function estimateTokens(text: string): number {
	const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
	return Math.ceil(cjk + (text.length - cjk) / 4);
}

/** One attached file as stored: its text in units (a PDF's pages, otherwise one), and the PDF itself for rendering. */
export interface StoredAttachment {
	id: string;
	/** The bot it was attached in; its attachments go when the bot does. */
	conversationId: string;
	name: string;
	kind: AttachmentKind;
	size: number;
	createdAt: number;
	/** PDF: one per page. Others: the whole text as the only unit. */
	units: string[];
	/** PDF pages (1-based) with no text layer, likely scanned. */
	blankPages?: number[];
	/** Those of them whose text came from OCR on the phone (ScannerPlugin), which may have errors. */
	ocrPages?: number[];
	/** Spreadsheets: the tables they were imported as. */
	tables?: { name: string; sheet: string; rows: number; columns: string[] }[];
	/** PDF: the file, to render pages from. */
	blob?: Blob;
}

const files = idbStore("pi-attachments", "files", { keyPath: "id" });

export async function saveAttachment(attachment: StoredAttachment): Promise<void> {
	await files.request("readwrite", (store) => store.put(attachment));
}

function isStored(value: unknown): value is StoredAttachment {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "id") === "string" && Array.isArray(Reflect.get(value, "units"));
}

export async function loadAttachment(id: string): Promise<StoredAttachment | undefined> {
	const value: unknown = await files.request("readonly", (store) => store.get(id));
	return isStored(value) ? value : undefined;
}

/** Delete one attachment (removed before it was sent), or all of a bot's (the bot was deleted). */
export async function deleteAttachments(which: { id: string } | { conversationId: string }): Promise<void> {
	if ("id" in which) {
		await files.request("readwrite", (store) => store.delete(which.id));
		return;
	}
	await files.transaction("readwrite", (store) => {
		const cursor = store.openCursor();
		cursor.onsuccess = () => {
			const current = cursor.result;
			if (!current) return;
			if (isStored(current.value) && current.value.conversationId === which.conversationId) current.delete();
			current.continue();
		};
	});
}

/** The bots that have stored attachments. */
export async function attachmentOwners(): Promise<string[]> {
	const owners = new Set<string>();
	await files.transaction("readonly", (store) => {
		const cursor = store.openCursor();
		cursor.onsuccess = () => {
			const current = cursor.result;
			if (!current) return;
			if (isStored(current.value)) owners.add(current.value.conversationId);
			current.continue();
		};
	});
	return [...owners];
}

export const newAttachmentId = () => `att_${crypto.randomUUID().slice(0, 8)}`;

/** The full text, a PDF's pages marked so the model can cite them. */
export function fullText(attachment: Pick<StoredAttachment, "kind" | "units">): string {
	if (attachment.kind !== "pdf") return attachment.units[0] ?? "";
	return attachment.units.map((page, index) => `--- page ${index + 1} ---\n${page}`).join("\n\n");
}

const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const unescape = (value: string) => value.replace(/&lt;/g, "<").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

/** The longest head of `text`, in whole lines, within `tokens`; its line count. */
function head(text: string, tokens: number): { text: string; lines: number } {
	const lines = text.split("\n");
	let used = 0;
	let count = 0;
	for (const line of lines) {
		used += estimateTokens(line) + 1;
		if (used > tokens && count > 0) break;
		count++;
	}
	return { text: lines.slice(0, count).join("\n"), lines: count };
}

/** The message text for an attachment: an <attachment> element with the file's text, or a preview and how to read on. */
export function formatAttachment(attachment: StoredAttachment): TextContent {
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
		attributes.shown = `lines 1-${preview.lines} of ${text.split("\n").length}`;
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

/** An attachment's card from its message text; undefined for other text. */
export function parseAttachment(text: string): AttachmentCard | undefined {
	const match = OPEN_TAG.exec(text);
	if (!match) return undefined;
	const attributes = Object.fromEntries([...match[1].matchAll(/(\w+)="([^"]*)"/g)].map(([, key, value]) => [key, unescape(value)]));
	const kind = attributes.type;
	if (!attributes.id || !attributes.name || (kind !== "pdf" && kind !== "docx" && kind !== "sheet" && kind !== "text")) return undefined;
	return { id: attributes.id, name: attributes.name, kind, size: Number(attributes.size) || 0, ...(attributes.pages ? { pages: Number(attributes.pages) } : {}) };
}

/** A message's content without its attachments' text and decoded codes, for copying what the user wrote. */
export function withoutAttachments<T extends { type: string; text?: string }>(content: readonly T[]): T[] {
	return content.filter((block) => block.type !== "text" || !block.text || (!OPEN_TAG.test(block.text) && !isCodeNote(block.text)));
}

/** A prepared attachment: its message text and any page images to send with it. */
export interface PreparedAttachment {
	card: AttachmentCard;
	content: (TextContent | ImageContent)[];
	/** Tables a spreadsheet was imported as, dropped again when the user removes it before sending. */
	tables: string[];
}

/**
 * Turn a picked file into an attachment: extract its text (the PDF, Word and spreadsheet readers load only when such a
 * file comes), import a spreadsheet's sheets, store it, and build its message content. Rejects with a message for the
 * user when the file is not one of the kinds or cannot be read.
 */
export async function prepareAttachment(file: File, conversationId: string): Promise<PreparedAttachment> {
	const kind = attachmentKind(file);
	if (!kind) throw new Error(`不支援這種檔案：${file.name}（可以傳 PDF、Word、Excel、CSV 和純文字）`);
	const base = { id: newAttachmentId(), conversationId, name: file.name, kind, size: file.size, createdAt: Date.now() };
	let stored: StoredAttachment;
	let images: (ImageContent | TextContent)[] = [];
	switch (kind) {
		case "pdf": {
			const pdf = await import("./attachments-pdf.ts");
			const { units, blankPages } = await pdf.extractPdf(file);
			// Scanned pages: their text by OCR, so they read and search like the rest; pages with none go as images.
			const ocrPages: number[] = [];
			const imageOnly: ImageContent[] = [];
			const scans: { page: number; image: ImageContent }[] = [];
			for (const page of blankPages) {
				const [image] = await pdf.renderPages(file, [page]);
				if (!image) continue;
				scans.push({ page, image });
				const read = await ocr(image.data);
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
	await saveAttachment(stored);
	const card: AttachmentCard = { id: stored.id, name: stored.name, kind, size: stored.size, ...(kind === "pdf" ? { pages: stored.units.length } : {}) };
	return { card, content: [formatAttachment(stored), ...images], tables: (stored.tables ?? []).map((table) => table.name) };
}
