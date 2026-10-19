// Overlays (drawer, sheets, dialogs, settings) as browser history entries, so Android's back gesture closes the
// top overlay instead of leaving the app. @capacitor/app goes back in the WebView while it can, else exits.
import { useEffect, useRef, useState } from "react";

const open: (() => void)[] = [];
let ignorePops = 0;

window.addEventListener("popstate", () => {
	if (ignorePops > 0) {
		ignorePops--;
		return;
	}
	open.pop()?.();
});

/** While `active`, the back gesture calls `onBack`. Closing by other means removes the history entry again. */
export function useBack(active: boolean, onBack: () => void): void {
	const latest = useRef(onBack);
	latest.current = onBack;
	useEffect(() => {
		if (!active) return;
		const entry = () => latest.current();
		open.push(entry);
		history.pushState({ layer: open.length }, "");
		return () => {
			const index = open.indexOf(entry);
			if (index === -1) return; // Already popped by the back gesture.
			open.splice(index, 1);
			ignorePops++;
			history.back();
		};
	}, [active]);
}

const EXIT_MS = 180;

/**
 * Mount state for an overlay with an exit animation: `shown` stays true for EXIT_MS after `open` turns false,
 * with `closing` set so CSS can play the exit.
 */
export function usePresence(isOpen: boolean): { shown: boolean; closing: boolean } {
	const [shown, setShown] = useState(isOpen);
	useEffect(() => {
		if (isOpen) {
			setShown(true);
			return;
		}
		const timer = setTimeout(() => setShown(false), EXIT_MS);
		return () => clearTimeout(timer);
	}, [isOpen]);
	return { shown: shown || isOpen, closing: shown && !isOpen };
}
