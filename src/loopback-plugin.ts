import { type PluginListenerHandle, registerPlugin } from "@capacitor/core";

interface LoopbackPlugin {
	start(options: { port: number; path: string }): Promise<{ port: number }>;
	stop(): Promise<void>;
	addListener(event: "redirect", listener: (data: { url: string }) => void): Promise<PluginListenerHandle>;
}

const Loopback = registerPlugin<LoopbackPlugin>("Loopback");

export async function listenForRedirect(at: { port: number; path: string }, onRedirect: (url: URL) => void): Promise<() => Promise<void>> {
	await Loopback.start(at);
	const handle = await Loopback.addListener("redirect", ({ url }) => onRedirect(new URL(url)));
	return async () => {
		await handle.remove();
		await Loopback.stop();
	};
}
