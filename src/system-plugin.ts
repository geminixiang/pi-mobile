// SystemPlugin on Android (SystemPlugin.java): the user's browser, the clipboard, and haptic ticks.
import { registerPlugin } from "@capacitor/core";

export const System = registerPlugin<{
	openExternal(options: { url: string }): Promise<void>;
	clipboardText(): Promise<{ text: string }>;
	/** Whether pi is the digital assistant, and the system page to choose it. */
	assistant(): Promise<{ held: boolean }>;
	openAssistantSettings(): Promise<void>;
	/** Fingerprint, face, or the screen lock; ok false when cancelled or failed. */
	authenticate(options: { title: string; subtitle?: string }): Promise<{ ok: boolean; reason?: string }>;
}>("System");
