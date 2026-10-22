// read_attachment: the rest of a file the user attached, when its message showed only the start (attachments.ts). By
// line window, by PDF pages, or by search; PDF pages also as images, for scans, charts, and layout. Always on and not
// listed in the bot panel, like memory: it matters only in conversations with attachments, and costs little.
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { defineExtension } from "@earendil-works/pi-durable";
import { estimateTokens, fullText, loadAttachment, normalizeCjk, prepareAttachment } from "../attachments.ts";
import { inboxFile, Scanner } from "../../scanner-plugin.ts";
import { codeNote } from "../codes.ts";
import { defineAppTool, requireNative } from "./common.ts";

const DEFAULT_LINES = 400;
/** One call returns at most this much text, so one read cannot flood the context; the notice says where to go on. */
const MAX_TOKENS = 8_000;
const MAX_IMAGES = 4;
const MAX_MATCHES = 20;

/** "3", "3-5", "1,4,7-8" as page numbers within 1..count. */
function pageList(spec: string, count: number): number[] {
	const pages = new Set<number>();
	for (const part of spec.split(",")) {
		const [from, to] = part.split("-").map((value) => Number.parseInt(value.trim(), 10));
		if (!Number.isFinite(from)) continue;
		for (let page = from; page <= (Number.isFinite(to) ? to : from); page++) if (page >= 1 && page <= count) pages.add(page);
	}
	return [...pages].sort((a, b) => a - b);
}

/** Lines from `start` (1-based) up to `limit` lines or MAX_TOKENS, and where the next window starts. */
function window(lines: string[], start: number, limit: number): { text: string; next?: number } {
	const out: string[] = [];
	let tokens = 0;
	let index = start - 1;
	for (; index < lines.length && out.length < limit; index++) {
		tokens += estimateTokens(lines[index]) + 1;
		if (tokens > MAX_TOKENS && out.length > 0) break;
		out.push(`${index + 1}\t${lines[index]}`);
	}
	return { text: out.join("\n"), ...(index < lines.length ? { next: index + 1 } : {}) };
}

const readAttachment = defineAppTool({
	name: "read_attachment",
	description: [
		"Read a file the user attached, by the id in its <attachment> tag. Use it when the message shows only the start of the file, or to look at PDF pages as images.",
		"With offset/limit: a window of lines, numbered. With pages (PDF): those pages' text, or with images=true those pages as pictures (charts, scans, layout; at most 4). With query: the matching lines and their pages.",
	].join(" "),
	parameters: Type.Object({
		id: Type.String({ description: "The id attribute of the <attachment> tag" }),
		offset: Type.Optional(Type.Integer({ minimum: 1, description: "First line, 1-based (default 1)" })),
		limit: Type.Optional(Type.Integer({ minimum: 1, description: `Lines to read (default ${DEFAULT_LINES})` })),
		pages: Type.Optional(Type.String({ description: 'PDF pages, such as "3" or "4-6"' })),
		images: Type.Optional(Type.Boolean({ description: "With pages: the pages as images instead of text" })),
		query: Type.Optional(Type.String({ description: "Find lines containing this text (case-insensitive)" })),
	}),
	execute: async (args) => {
		const attachment = await loadAttachment(args.id);
		if (!attachment) throw new Error(`no attachment ${args.id} on this phone`);
		const output: (TextContent | ImageContent)[] = [];
		const isPdf = attachment.kind === "pdf";

		if (args.query !== undefined) {
			const needle = normalizeCjk(args.query).toLowerCase();
			const matches: string[] = [];
			attachment.units.forEach((unit, unitIndex) => {
				unit.split("\n").forEach((line, lineIndex) => {
					if (matches.length < MAX_MATCHES && normalizeCjk(line).toLowerCase().includes(needle)) {
						matches.push(`${isPdf ? `page ${unitIndex + 1}` : `line ${lineIndex + 1}`}: ${line.trim()}`);
					}
				});
			});
			output.push({ type: "text", text: matches.length ? matches.join("\n") : `No lines contain "${args.query}".` });
			return { output };
		}

		if (args.pages !== undefined) {
			if (!isPdf) throw new Error("pages is for PDFs; use offset and limit");
			const pages = pageList(args.pages, attachment.units.length);
			if (pages.length === 0) throw new Error(`no such pages; the PDF has ${attachment.units.length}`);
			if (args.images) {
				if (!attachment.blob) throw new Error("the PDF itself is not stored; only its text");
				const shown = pages.slice(0, MAX_IMAGES);
				const { renderPages } = await import("../attachments-pdf.ts");
				output.push({ type: "text", text: `Pages ${shown.join(", ")} of ${attachment.name}${pages.length > shown.length ? ` (${MAX_IMAGES} at a time)` : ""}:` });
				const images = await renderPages(attachment.blob, shown);
				output.push(...images);
				const codes = await codeNote(images, (index) => `page ${shown[index]}`);
				if (codes) output.push(codes);
				return { output };
			}
			const text = pages.map((page) => `--- page ${page} ---\n${attachment.units[page - 1]}`).join("\n\n");
			const read = window(text.split("\n"), 1, Number.MAX_SAFE_INTEGER);
			output.push({ type: "text", text: read.next ? `${read.text}\n[Cut at ${MAX_TOKENS} tokens; ask for fewer pages.]` : read.text });
			return { output };
		}

		const lines = fullText(attachment).split("\n");
		const start = args.offset ?? 1;
		if (start > lines.length) throw new Error(`the file has ${lines.length} lines`);
		const read = window(lines, start, args.limit ?? DEFAULT_LINES);
		output.push({ type: "text", text: read.next ? `${read.text}\n[${lines.length - read.next + 1} more lines; continue with offset=${read.next}.]` : read.text });
		return { output };
	},
});

const scanDocument = defineAppTool({
	name: "scan_document",
	description:
		"Open the phone's document scanner for the user to photograph paper (a contract, a receipt, a letter): it finds the edges and flattens the pages. Returns the pages as an attachment with their text (OCR on the phone), like a PDF the user attached. Only when the user asks to scan something now.",
	parameters: Type.Object({ pages: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "At most this many pages (default 20)" })) }),
	execute: async (args, api) => {
		requireNative();
		let scan: { pdf: string; pages: number };
		try {
			scan = await Scanner.scan({ pages: args.pages ?? 20 });
		} catch (error) {
			if (error instanceof Error && Reflect.get(error, "code") === "cancelled") {
				return { output: [{ type: "text", text: "The user closed the scanner; nothing was scanned. Reply with one short sentence that says so, such as 「好，沒有掃。」" }], isError: true };
			}
			throw error;
		}
		const stamp = new Date().toLocaleString("sv-SE").slice(0, 16).replace(/[-: ]/g, "");
		const file = await inboxFile(scan.pdf, `掃描 ${stamp}.pdf`, "application/pdf");
		const prepared = await prepareAttachment(file, String(api.conversationId));
		return { output: prepared.content };
	},
});

export const AttachmentsExtension = defineExtension({ name: "attachments", tools: [readAttachment, scanDocument] });
