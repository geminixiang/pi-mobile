import { type DependencyList, useCallback, useRef, useSyncExternalStore } from "react";

export type Subscribe<T> = (listener: (value: T) => void) => (() => void) | undefined;

export function useSubscribed<T>(initial: T, subscribe: Subscribe<T>, deps: DependencyList): T {
	const latest = useRef(initial);
	const attach = useCallback(
		(changed: () => void) =>
			subscribe((value) => {
				latest.current = value;
				changed();
			}) ?? (() => undefined),
		deps,
	);
	return useSyncExternalStore(attach, () => latest.current);
}
