import { App } from "@capacitor/app";
import type { Cancel } from "pi-mobile-base/time";
import type { Subscribe } from "./subscribed.ts";

export function onResume(run: () => void): Cancel {
	const resume = App.addListener("resume", run);
	return () => void resume.then((handle) => handle.remove());
}

export function resumed<T>(read: (() => Promise<T>) | undefined): Subscribe<T> {
	return (listener) => {
		if (!read) return undefined;
		let live = true;
		const refresh = () => void read().then((value) => live && listener(value));
		refresh();
		const stop = onResume(refresh);
		return () => {
			live = false;
			stop();
		};
	};
}
