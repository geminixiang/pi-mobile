// LoopbackPlugin.java: the loopback redirect of a sign-in in the browser (RFC 8252 section 7.3), for MCP servers and
// Sign in with ChatGPT. One address at a time; starting again replaces the last one.
import { type PluginListenerHandle, registerPlugin } from "@capacitor/core";

interface LoopbackPlugin {
	start(options: { port: number; path: string }): Promise<{ port: number }>;
	stop(): Promise<void>;
	addListener(event: "redirect", listener: (data: { url: string }) => void): Promise<PluginListenerHandle>;
}

export const Loopback = registerPlugin<LoopbackPlugin>("Loopback");
