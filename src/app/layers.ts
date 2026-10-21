// Overlays (side panels, sheets, dialogs, pages, directory levels) as a stack, so Android's back gesture closes the top
// one instead of leaving the app.
//
// Back comes from @capacitor/app's backButton event, not browser history: Chromium skips history entries a page
// pushed without a user gesture, so entries added while re-arming after a back, or when an overlay opens from code,
// would make back silently do nothing. With an empty stack, back moves the app to the background like the home
// button, so a running agent keeps going.
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { useEffect, useRef } from "react";

const stack: (() => void)[] = [];
// Debug hook for test/cdp.ts.
Object.assign(globalThis, { piLayers: stack });

if (Capacitor.isNativePlatform()) {
	void App.addListener("backButton", () => {
		// The layer leaves the stack when it actually closes, so a modal that ignores back stays on top.
		const top = stack.at(-1);
		if (top) top();
		else void App.minimizeApp();
	});
}

/** While `active`, the back gesture calls `onBack`. The most recently activated layer goes first. */
export function useBack(active: boolean, onBack: () => void): void {
	const latest = useRef(onBack);
	latest.current = onBack;
	useEffect(() => {
		if (!active) return;
		const entry = () => latest.current();
		stack.push(entry);
		return () => {
			const index = stack.indexOf(entry);
			if (index !== -1) stack.splice(index, 1);
		};
	}, [active]);
}
