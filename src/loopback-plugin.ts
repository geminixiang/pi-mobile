import { type PluginListenerHandle, registerPlugin } from "@capacitor/core";

interface LoopbackPlugin {
	start(options: { port: number; path: string }): Promise<{ port: number }>;
	stop(): Promise<void>;
	addListener(event: "redirect", listener: (data: { url: string }) => void): Promise<PluginListenerHandle>;
}

export const Loopback = registerPlugin<LoopbackPlugin>("Loopback");
