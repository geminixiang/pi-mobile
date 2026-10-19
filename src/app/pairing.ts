// Pairing links printed by sandbox/install.sh (pimobile://pair?url=...&token=...&name=...). Scanning the QR code
// with the phone's camera, or tapping the link, opens the app with it.
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";

export interface Pairing {
	url: string;
	token: string;
	name: string;
}

export function parsePairing(link: string): Pairing | undefined {
	let url: URL;
	try {
		url = new URL(link);
	} catch {
		return undefined;
	}
	if (url.protocol !== "pimobile:" || url.hostname !== "pair") return undefined;
	const relay = url.searchParams.get("url") ?? "";
	const token = url.searchParams.get("token") ?? "";
	if (!/^wss?:\/\//.test(relay) || !token) return undefined;
	return { url: relay, token, name: url.searchParams.get("name") || new URL(relay.replace(/^ws/, "http")).hostname };
}

/** Calls `onPairing` for the link the app was launched with and for every link opened while it runs. */
export function listenForPairing(onPairing: (pairing: Pairing) => void): () => void {
	if (!Capacitor.isNativePlatform()) return () => undefined;
	const handle = (link: string | undefined) => {
		const pairing = link ? parsePairing(link) : undefined;
		if (pairing) onPairing(pairing);
	};
	void App.getLaunchUrl().then((launch) => handle(launch?.url));
	const listener = App.addListener("appUrlOpen", ({ url }) => handle(url));
	return () => void listener.then((h) => h.remove());
}
