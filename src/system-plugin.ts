import { registerPlugin } from "@capacitor/core";

export const System = registerPlugin<{
	openExternal(options: { url: string }): Promise<void>;
	haptic(options: { kind: "tick" | "press" | "confirm" }): Promise<void>;
	clipboardText(): Promise<{ text: string }>;
	assistant(): Promise<{ held: boolean }>;
	openAssistantSettings(): Promise<void>;
}>("System");
