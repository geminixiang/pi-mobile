import { useCallback, useState } from "react";
import { after } from "pi-mobile-base/time";
import { useSubscribed } from "./subscribed.ts";

const SHOWN_MS = 2000;

export function useExpired(since: object | undefined, ms: number): boolean {
	const expired = useSubscribed<object | undefined>(undefined, (listener) => since && after(ms, () => listener(since)), [since, ms]);
	return since !== undefined && expired === since;
}

export function useBriefly(): [string | undefined, (text: string) => void] {
	const [shown, setShown] = useState<{ text: string }>();
	const show = useCallback((text: string) => setShown({ text }), []);
	return [useExpired(shown, SHOWN_MS) ? undefined : shown?.text, show];
}
