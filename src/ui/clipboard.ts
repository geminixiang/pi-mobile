import { native } from "../native.ts";
import { System } from "../plugins/system.ts";

export function copy(text: string): Promise<void> {
	return navigator.clipboard.writeText(text);
}

export async function pasted(): Promise<string> {
	if (native.has("System")) return (await System.clipboardText()).text;
	return navigator.clipboard.readText();
}
