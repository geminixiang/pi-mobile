import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { orLogged } from "../promise.ts";
import { fromBase64 } from "../encoding.ts";

const CODES_TAG = "image-codes";

interface DetectedCode {
	format: string;
	rawValue: string;
}

interface Detector {
	detect(image: ImageBitmap): Promise<DetectedCode[]>;
}

const isDetector = (value: unknown): value is Detector => typeof value === "object" && value !== null && typeof Reflect.get(value, "detect") === "function";

function detector(): Detector | undefined {
	const Barcode: unknown = Reflect.get(globalThis, "BarcodeDetector");
	if (typeof Barcode !== "function") return undefined;
	const made: unknown = Reflect.construct(Barcode, []);
	return isDetector(made) ? made : undefined;
}

export const isCodeNote = (text: string) => text.startsWith(`<${CODES_TAG}>`);

async function codesIn(image: ImageContent, find: Detector): Promise<DetectedCode[]> {
	const bytes = fromBase64(image.data);
	const bitmap = await createImageBitmap(new Blob([bytes], { type: image.mimeType }));
	try {
		return await find.detect(bitmap);
	} finally {
		bitmap.close();
	}
}

export async function codeNote(images: readonly ImageContent[], label: (index: number) => string = (index) => `image ${index + 1}`): Promise<TextContent | undefined> {
	const find = detector();
	if (!find || images.length === 0) return undefined;
	const lines: string[] = [];
	for (const [index, image] of images.entries()) {
		const codes = await orLogged(codesIn(image, find), "codes.image_unreadable", []);
		for (const code of codes) lines.push(`${label(index)}: ${code.format} ${JSON.stringify(code.rawValue)}`);
	}
	if (lines.length === 0) return undefined;
	return { type: "text", text: `<${CODES_TAG}>\nDecoded on the phone (exact, unlike reading the picture):\n${lines.join("\n")}\n</${CODES_TAG}>` };
}
