import { Loopback } from "./plugins/loopback.ts";

export async function listenForRedirect(at: { port: number; path: string }, onRedirect: (url: URL) => void): Promise<() => Promise<void>> {
	await Loopback.start(at);
	const handle = await Loopback.addListener("redirect", ({ url }) => onRedirect(new URL(url)));
	return async () => {
		await handle.remove();
		await Loopback.stop();
	};
}
