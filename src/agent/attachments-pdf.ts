import type { ImageContent } from "@earendil-works/pi-ai";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { normalizeCjk } from "./attachments.ts";

GlobalWorkerOptions.workerSrc = workerUrl;

const BLANK_PAGE_CHARS = 20;
const MAX_IMAGE_EDGE = 1600;

async function openPdf(data: ArrayBuffer): Promise<PDFDocumentProxy> {
	return getDocument({
		data: new Uint8Array(data),
		cMapUrl: "/pdfjs/cmaps/",
		cMapPacked: true,
		standardFontDataUrl: "/pdfjs/standard_fonts/",
		wasmUrl: "/pdfjs/wasm/",
	}).promise;
}

const isTextItem = (item: unknown): item is TextItem => typeof item === "object" && item !== null && typeof Reflect.get(item, "str") === "string";

export async function extractPdf(file: Blob): Promise<{ units: string[]; blankPages: number[] }> {
	const pdf = await openPdf(await file.arrayBuffer());
	try {
		const units: string[] = [];
		const blankPages: number[] = [];
		for (let number = 1; number <= pdf.numPages; number++) {
			const page = await pdf.getPage(number);
			const content = await page.getTextContent();
			const text = content.items
				.filter(isTextItem)
				.map((item) => item.str + (item.hasEOL ? "\n" : ""))
				.join("")
				.replace(/[ \t]+\n/g, "\n")
				.replace(/\n{3,}/g, "\n\n")
				.trim();
			units.push(normalizeCjk(text));
			if (text.replace(/\s/g, "").length < BLANK_PAGE_CHARS) blankPages.push(number);
			page.cleanup();
		}
		return { units, blankPages };
	} finally {
		await pdf.loadingTask.destroy();
	}
}

export async function renderPages(file: Blob, pages: readonly number[]): Promise<ImageContent[]> {
	const pdf = await openPdf(await file.arrayBuffer());
	try {
		const images: ImageContent[] = [];
		for (const number of pages) {
			if (number < 1 || number > pdf.numPages) continue;
			const page = await pdf.getPage(number);
			const base = page.getViewport({ scale: 1 });
			const viewport = page.getViewport({ scale: Math.min(3, MAX_IMAGE_EDGE / Math.max(base.width, base.height)) });
			const canvas = document.createElement("canvas");
			canvas.width = Math.round(viewport.width);
			canvas.height = Math.round(viewport.height);
			await page.render({ canvas, viewport, background: "#ffffff" }).promise;
			const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
			images.push({ type: "image", mimeType: "image/jpeg", data: dataUrl.slice(dataUrl.indexOf(",") + 1) });
			page.cleanup();
		}
		return images;
	} finally {
		await pdf.loadingTask.destroy();
	}
}
