// ScannerPlugin on Android (ScannerPlugin.java): ML Kit's document scanner and Chinese text recognition, through
// Google Play services.
import { Capacitor, registerPlugin } from "@capacitor/core";

export const Scanner = registerPlugin<{
	/** The scanner's screen; rejects with code "cancelled" when the user backs out. Paths are in the native inbox. */
	scan(options: { pages?: number }): Promise<{ pdf: string; pages: number; images: string[] }>;
	/** Text in a base64 image, Chinese and Latin script. */
	ocr(options: { data: string }): Promise<{ text: string }>;
}>("Scanner");

/** A file the scanner left in the native inbox, as a File, through Capacitor's file server. */
export async function inboxFile(path: string, name: string, type: string): Promise<File> {
	const blob = await (await fetch(Capacitor.convertFileSrc(path))).blob();
	return new File([blob], name, { type });
}

/** Text in an image on the phone; "" off Android or when nothing is legible. */
export async function ocr(data: string): Promise<string> {
	if (!Capacitor.isNativePlatform()) return "";
	return (await Scanner.ocr({ data }).catch(() => ({ text: "" }))).text.trim();
}
