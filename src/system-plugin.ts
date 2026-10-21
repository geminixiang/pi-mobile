// SystemPlugin on Android (SystemPlugin.java): the user's browser, the clipboard, and haptic ticks.
import { registerPlugin } from "@capacitor/core";

export const System = registerPlugin<{
	openExternal(options: { url: string }): Promise<void>;
	clipboardText(): Promise<{ text: string }>;
}>("System");
