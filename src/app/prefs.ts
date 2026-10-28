import { useCallback, useState } from "react";
import { type Static, Type } from "typebox";
import { readStored } from "../agent/parse.ts";

const KEY = "pi-mobile.prefs";

const StoredPrefs = Type.Partial(Type.Object({ showThinking: Type.Boolean(), expandTools: Type.Boolean() }));
export type Prefs = Required<Static<typeof StoredPrefs>>;

const DEFAULTS: Prefs = { showThinking: true, expandTools: false };

export function usePrefs(): [Prefs, (change: Partial<Prefs>) => void] {
	const [prefs, setPrefs] = useState<Prefs>(() => ({ ...DEFAULTS, ...readStored(StoredPrefs, KEY) }));
	const update = useCallback((change: Partial<Prefs>) => {
		setPrefs((current) => {
			const next = { ...current, ...change };
			localStorage.setItem(KEY, JSON.stringify(next));
			return next;
		});
	}, []);
	return [prefs, update];
}
