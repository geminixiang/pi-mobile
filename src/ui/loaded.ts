import { type DependencyList, useMemo, useSyncExternalStore } from "react";
import { messageOf } from "../promise.ts";
import { every } from "../time.ts";
import { cell, type Source, useSubscribed } from "./subscribed.ts";

export function usePolled<T>(read: (() => Promise<T | undefined>) | undefined, everyMs: number, deps: DependencyList): T | undefined {
	return useSubscribed<T | undefined>(
		undefined,
		(listener) => {
			if (!read) return undefined;
			let live = true;
			const poll = () => void read().then((value) => live && value !== undefined && listener(value));
			poll();
			const stop = every(everyMs, poll);
			return () => {
				live = false;
				stop();
			};
		},
		deps,
	);
}

type Loaded<T> = { value: T | undefined; error: string };

const LOADING = { value: undefined, error: "" };

function loading<T>(load: (() => Promise<T>) | undefined): Source<Loaded<T>> {
	const state = cell<Loaded<T>>(LOADING);
	return {
		read: state.read,
		subscribe: (changed) => {
			let live = true;
			const unwatch = state.subscribe(changed);
			load?.().then(
				(value) => live && state.set({ value, error: "" }),
				(failure: unknown) => live && state.set({ value: undefined, error: messageOf(failure) }),
			);
			return () => {
				live = false;
				unwatch();
			};
		},
	};
}

export function useLoaded<T>(load: (() => Promise<T>) | undefined, deps: DependencyList): Loaded<T> {
	const store = useMemo(() => loading(load), deps);
	return useSyncExternalStore(store.subscribe, store.read);
}
