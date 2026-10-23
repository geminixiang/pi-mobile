// QR codes and barcodes in images, decoded on the phone with the WebView's BarcodeDetector (Android's own, through
// Chromium; 13 formats on the S24). Models read the picture of a code poorly, so wherever images reach the model
// (photos the user attaches, view_photos, PDF pages) their codes go along as text. No tool: it costs no tokens when
// there is no code.
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

const CODES_TAG = "image-codes";

interface DetectedCode {
	format: string;
	rawValue: string;
}

interface Detector {
	detect(image: ImageBitmap): Promise<DetectedCode[]>;
}

const isDetector = (value: unknown): value is Detector => typeof value === "object" && value !== null && typeof Reflect.get(value, "detect") === "function";

/** The WebView's BarcodeDetector; undefined where there is none (TypeScript's DOM types do not have it yet). */
function detector(): Detector | undefined {
	const Barcode: unknown = Reflect.get(globalThis, "BarcodeDetector");
	if (typeof Barcode !== "function") return undefined;
	const made: unknown = Reflect.construct(Barcode, []);
	return isDetector(made) ? made : undefined;
}

/** A message's text block of decoded codes: the model's, not shown in the transcript. */
export const isCodeNote = (text: string) => text.startsWith(`<${CODES_TAG}>`);

async function codesIn(image: ImageContent, find: Detector): Promise<DetectedCode[]> {
	const bytes = Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0));
	const bitmap = await createImageBitmap(new Blob([bytes], { type: image.mimeType }));
	try {
		return await find.detect(bitmap);
	} finally {
		bitmap.close();
	}
}

/** The codes found in `images`, as one text block naming the image each is in; undefined when there are none. */
export async function codeNote(images: readonly ImageContent[], label: (index: number) => string = (index) => `image ${index + 1}`): Promise<TextContent | undefined> {
	const find = detector();
	if (!find || images.length === 0) return undefined;
	const lines: string[] = [];
	for (const [index, image] of images.entries()) {
		const codes = await codesIn(image, find).catch(() => []);
		for (const code of codes) lines.push(`${label(index)}: ${code.format} ${JSON.stringify(code.rawValue)}`);
	}
	if (lines.length === 0) return undefined;
	return { type: "text", text: `<${CODES_TAG}>\nDecoded on the phone (exact, unlike reading the picture):\n${lines.join("\n")}\n</${CODES_TAG}>` };
}
