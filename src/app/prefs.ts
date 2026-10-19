// Display preferences, the mobile counterparts of pi's Ctrl+T (thinking) and Ctrl+O (tool output) toggles.
import { useCallback, useState } from "react";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const KEY = "pi-mobile.prefs";

const StoredPrefs = Type.Partial(Type.Object({ showThinking: Type.Boolean(), expandTools: Type.Boolean() }));
export type Prefs = Required<Static<typeof StoredPrefs>>;

const DEFAULTS: Prefs = { showThinking: true, expandTools: false };

function loadPrefs(): Prefs {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
		return { ...DEFAULTS, ...(Value.Check(StoredPrefs, value) ? value : {}) };
	} catch {
		return DEFAULTS;
	}
}


export function usePrefs(): [Prefs, (change: Partial<Prefs>) => void] {
	const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
	const update = useCallback((change: Partial<Prefs>) => {
		setPrefs((current) => {
			const next = { ...current, ...change };
			localStorage.setItem(KEY, JSON.stringify(next));
			return next;
		});
	}, []);
	return [prefs, update];
}
