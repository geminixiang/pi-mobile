import type { PluginListenerHandle } from "@capacitor/core";
import { registerPlugin } from "@capacitor/core";

export interface VoicePlugin {
	available(): Promise<{ available: boolean }>;
	start(options: { language: string }): Promise<void>;
	stop(): Promise<void>;
	cancel(): Promise<void>;
	speak(options: { text: string; language: string }): Promise<{ spoken: boolean; reason?: string }>;
	stopSpeaking(): Promise<void>;
	addListener(event: "partial" | "final", listener: (data: { text: string }) => void): Promise<PluginListenerHandle>;
	addListener(event: "level", listener: (data: { rms: number }) => void): Promise<PluginListenerHandle>;
	addListener(event: "error", listener: (data: { code: number; message: string }) => void): Promise<PluginListenerHandle>;
	addListener(event: "ready" | "end", listener: () => void): Promise<PluginListenerHandle>;
}

export const Voice = registerPlugin<VoicePlugin>("Voice");
