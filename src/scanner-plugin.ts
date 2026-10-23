import { Capacitor, registerPlugin } from "@capacitor/core";

export const Scanner = registerPlugin<{
	scan(options: { pages?: number }): Promise<{ cancelled: true } | { cancelled: false; pdf: string; pages: number }>;
	ocr(options: { data: string }): Promise<{ text: string }>;
}>("Scanner");

export async function inboxFile(path: string, name: string, type: string): Promise<File> {
	const blob = await (await fetch(Capacitor.convertFileSrc(path))).blob();
	return new File([blob], name, { type });
}

export async function ocr(data: string): Promise<string> {
	if (!Capacitor.isNativePlatform()) return "";
	return (await Scanner.ocr({ data })).text.trim();
}
