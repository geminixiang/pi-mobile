import { type DependencyList, useCallback, useRef, useState, useSyncExternalStore } from "react";

export type Subscribe<T> = (listener: (value: T) => void) => (() => void) | undefined;

export type Source<T> = { subscribe: (changed: () => void) => () => void; read: () => T };

type Update<T> = T | ((current: T) => T);
type Write<T> = (next: Update<T>) => T;

const unwatched = () => undefined;

// why: T is unconstrained, so TypeScript cannot rule out a T that is itself a function; a store holds values, so a function here is always an update
const updated = <T>(next: Update<T>, current: T): T => (typeof next === "function" ? (next as (current: T) => T)(current) : next);

export function cell<T>(initial: T): Source<T> & { set: Write<T> } {
	let value = initial;
	const watchers = new Set<() => void>();
	return {
		read: () => value,
		subscribe: (changed) => {
			watchers.add(changed);
			return () => void watchers.delete(changed);
		},
		set: (next) => {
			value = updated(next, value);
			for (const changed of watchers) changed();
			return value;
		},
	};
}

export const CLOSED: Source<boolean> = { subscribe: () => unwatched, read: () => false };

export const defined = (source: Source<unknown>): Source<boolean> => ({ subscribe: source.subscribe, read: () => source.read() !== undefined });

export function useStore<T>(initial: T, subscribe: (set: Write<T>) => (() => void) | undefined, deps: DependencyList): [T, Write<T>, Source<T>] {
	const [store] = useState(() => cell(initial));
	const attach = useCallback((changed: () => void) => {
		const unwatch = store.subscribe(changed);
		const stop = subscribe(store.set);
		return () => {
			unwatch();
			stop?.();
		};
	}, deps);
	return [useSyncExternalStore(attach, store.read), store.set, store];
}

export function useSubscribed<T>(initial: T, subscribe: Subscribe<T>, deps: DependencyList): T {
	return useStore<T>(initial, subscribe, deps)[0];
}

export function useLast<T>(keep: boolean, value: T): T {
	const last = useRef(value);
	if (keep) last.current = value;
	return last.current;
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
