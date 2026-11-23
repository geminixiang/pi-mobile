import type { Cancel } from "pi-mobile-base/time";
import { backToTop } from "./layers.ts";
import { cell } from "../store/subscribed.ts";

export type Haptic = "tick" | "press" | "confirm";

export type UiPlatform = {
	haptic(kind: Haptic): void;
	onBack(taken: () => boolean): Cancel;
	onResume(run: () => void): Cancel;
	copy(text: string): Promise<void>;
	pasted(): Promise<string>;
};

const idle = () => undefined;

const DETACHED: UiPlatform = {
	haptic: idle,
	onBack: () => idle,
	onResume: () => idle,
	copy: () => Promise.resolve(),
	pasted: () => Promise.resolve(""),
};

const installed = cell(DETACHED);
const stopBack = cell<{ cancel: Cancel }>({ cancel: idle });

export const platform = installed.read;

export function installPlatform(next: UiPlatform): Cancel {
	stopBack.read().cancel();
	installed.set(next);
	const cancel = next.onBack(backToTop);
	stopBack.set({ cancel });
	return () => {
		if (stopBack.read().cancel !== cancel) return;
		stopBack.set({ cancel: idle });
		cancel();
	};
}
