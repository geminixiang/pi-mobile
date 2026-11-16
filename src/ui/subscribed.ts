import { type DependencyList, useCallback, useRef, useState, useSyncExternalStore } from "react";

export type Subscribe<T> = (listener: (value: T) => void) => (() => void) | undefined;

type Update<T> = T | ((current: T) => T);
type Write<T> = (next: Update<T>) => T;

const unwatched = () => undefined;

// why: T is unconstrained, so TypeScript cannot rule out a T that is itself a function; a store holds values, so a function here is always an update
const updated = <T>(next: Update<T>, current: T): T => (typeof next === "function" ? (next as (current: T) => T)(current) : next);

export function useStore<T>(initial: T, subscribe: (set: Write<T>) => (() => void) | undefined, deps: DependencyList): [T, Write<T>] {
	const store = useRef<{ value: T; changed: () => void }>({ value: initial, changed: unwatched });
	const set = useCallback((next: Update<T>) => {
		store.current.value = updated(next, store.current.value);
		store.current.changed();
		return store.current.value;
	}, []);
	const attach = useCallback((changed: () => void) => {
		store.current.changed = changed;
		const stop = subscribe(set);
		return () => {
			store.current.changed = unwatched;
			stop?.();
		};
	}, deps);
	return [useSyncExternalStore(attach, () => store.current.value), set];
}

export function useSubscribed<T>(initial: T, subscribe: Subscribe<T>, deps: DependencyList): T {
	return useStore<T>(initial, subscribe, deps)[0];
}

export function promised<T>(load: () => Promise<T>): Subscribe<T> {
	return (listener) => {
		let live = true;
		void load().then((value) => live && listener(value));
		return () => {
			live = false;
		};
	};
}

// why: useSyncExternalStore renders every change at once (SyncLane), so changes that arrive faster than a render pile up as renders; setState lets React fold them into one, which the streaming conversation needs
export function useBatched<T>(initial: T, subscribe: Subscribe<T>, deps: DependencyList): T {
	const [value, setValue] = useState(initial);
	const attach = useCallback(() => subscribe(setValue) ?? unwatched, deps);
	useSyncExternalStore(attach, unwatched);
	return value;
}
