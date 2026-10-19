// Display preferences, the mobile counterparts of pi's Ctrl+T (thinking) and Ctrl+O (tool output) toggles.
import { useCallback, useState } from "react";

const KEY = "pi-mobile.prefs";

export interface Prefs {
	showThinking: boolean;
	expandTools: boolean;
}

const DEFAULTS: Prefs = { showThinking: true, expandTools: false };

export function usePrefs(): [Prefs, (change: Partial<Prefs>) => void] {
	const [prefs, setPrefs] = useState<Prefs>(() => ({ ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") }));
	const update = useCallback((change: Partial<Prefs>) => {
		setPrefs((current) => {
			const next = { ...current, ...change };
			localStorage.setItem(KEY, JSON.stringify(next));
			return next;
		});
	}, []);
	return [prefs, update];
}
