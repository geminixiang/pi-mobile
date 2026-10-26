import type { TextContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { defineExtension } from "@earendil-works/pi-durable";
import { estimateTokens, fullText, loadAttachment, normalizeCjk, prepareAttachment } from "../attachments.ts";
import { scannedPdf } from "../../scanner-plugin.ts";
import { Scanner } from "../../plugins/scanner.ts";
import { codeNote } from "../codes.ts";
import { defineAppTool, text } from "./common.ts";

const DEFAULT_LINES = 400;
const MAX_TOKENS = 8_000;
const MAX_IMAGES = 4;
const MAX_MATCHES = 20;

function pageList(spec: string, count: number): number[] {
	const pages = new Set<number>();
	for (const part of spec.split(",")) {
		const [from, to] = part.split("-").map((value) => Number.parseInt(value.trim(), 10));
		if (!Number.isFinite(from)) continue;
		for (let page = from; page <= (Number.isFinite(to) ? to : from); page++) if (page >= 1 && page <= count) pages.add(page);
	}
	return [...pages].sort((a, b) => a - b);
}

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
	effect: "read",
	reach: "loaded",
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
		const isPdf = attachment.kind === "pdf";

		if (args.query !== undefined) {
			const needle = normalizeCjk(args.query).toLowerCase();
			const matches: string[] = [];
			for (const [unitIndex, unit] of attachment.units.entries()) {
				if (matches.length === MAX_MATCHES) break;
				for (const [lineIndex, line] of unit.split("\n").entries()) {
					if (matches.length === MAX_MATCHES) break;
					if (normalizeCjk(line).toLowerCase().includes(needle)) matches.push(`${isPdf ? `page ${unitIndex + 1}` : `line ${lineIndex + 1}`}: ${line.trim()}`);
				}
			}
			return text(matches.length ? matches.join("\n") : `No lines contain "${args.query}".`);
		}

		if (args.pages !== undefined) {
			if (!isPdf) throw new Error("pages is for PDFs; use offset and limit");
			const pages = pageList(args.pages, attachment.units.length);
			if (pages.length === 0) throw new Error(`no such pages; the PDF has ${attachment.units.length}`);
			if (args.images) {
				if (!attachment.blob) throw new Error("the PDF itself is not stored; only its text");
				const shown = pages.slice(0, MAX_IMAGES);
				const { renderPages } = await import("../attachments-pdf.ts");
				const images = await renderPages(attachment.blob, shown);
				const codes = await codeNote(images, (index) => `page ${shown[index]}`);
				const header: TextContent = { type: "text", text: `Pages ${shown.join(", ")} of ${attachment.name}${pages.length > shown.length ? ` (${MAX_IMAGES} at a time)` : ""}:` };
				return { output: [header, ...images, ...(codes ? [codes] : [])] };
			}
			const body = pages.map((page) => `--- page ${page} ---\n${attachment.units[page - 1]}`).join("\n\n");
			const read = window(body.split("\n"), 1, Number.MAX_SAFE_INTEGER);
			return text(read.next ? `${read.text}\n[Cut at ${MAX_TOKENS} tokens; ask for fewer pages.]` : read.text);
		}

		const lines = fullText(attachment).split("\n");
		const start = args.offset ?? 1;
		if (start > lines.length) throw new Error(`the file has ${lines.length} lines`);
		const read = window(lines, start, args.limit ?? DEFAULT_LINES);
		return text(read.next ? `${read.text}\n[${lines.length - read.next + 1} more lines; continue with offset=${read.next}.]` : read.text);
	},
});

const scanDocument = defineAppTool({
	name: "scan_document",
	effect: "screen",
	needs: [Scanner.scan],
	description:
		"Open the phone's document scanner for the user to photograph paper (a contract, a receipt, a letter): it finds the edges and flattens the pages. Returns the pages as an attachment with their text (OCR on the phone), like a PDF the user attached. Only when the user asks to scan something now.",
	parameters: Type.Object({ pages: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "At most this many pages (default 20)" })) }),
	execute: async (args, api) => {
		const scan = await Scanner.scan({ pages: args.pages ?? 20 });
		if (scan.cancelled) {
			return { ...text("The user closed the scanner; nothing was scanned. Reply with one short sentence that says so, such as 「好，沒有掃。」"), isError: true };
		}
		const file = await scannedPdf(scan.pdf);
		const prepared = await prepareAttachment(file, String(api.conversationId));
		return { output: prepared.content };
	},
});

export const AttachmentsExtension = defineExtension({ name: "attachments", tools: [readAttachment, scanDocument] });
