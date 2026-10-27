import { Capacitor } from "@capacitor/core";
import { native } from "./native.ts";
import { Scanner } from "./plugins/scanner.ts";

export async function inboxFile(path: string, name: string, type: string): Promise<File> {
	const blob = await (await fetch(Capacitor.convertFileSrc(path))).blob();
	return new File([blob], name, { type: type || blob.type });
}

export function scannedPdf(path: string): Promise<File> {
	const stamp = new Date().toLocaleString("sv-SE").slice(0, 16).replace(/[-: ]/g, "");
	return inboxFile(path, `掃描 ${stamp}.pdf`, "application/pdf");
}

export async function ocr(data: string): Promise<string> {
	if (!native.implements(Scanner.ocr)) return "";
	return (await Scanner.ocr({ data })).text.trim();
}
