import { type DependencyList, useEffect, useState } from "react";
import { messageOf } from "../promise.ts";

export function usePolled<T>(read: (() => Promise<T>) | undefined, onRead: (value: T) => void, everyMs: number, deps: DependencyList): void {
	useEffect(() => {
		if (!read) return;
		let live = true;
		const poll = async () => {
			const value = await read();
			if (live) onRead(value);
		};
		void poll();
		const timer = setInterval(() => void poll(), everyMs);
		return () => {
			live = false;
			clearInterval(timer);
		};
	}, deps);
}

export function useLoaded<T>(load: (() => Promise<T>) | undefined, deps: DependencyList): { value: T | undefined; error: string } {
	const [value, setValue] = useState<T>();
	const [error, setError] = useState("");
	useEffect(() => {
		if (!load) return;
		let live = true;
		setValue(undefined);
		setError("");
		load().then(
			(next) => live && setValue(next),
			(failure: unknown) => live && setError(messageOf(failure)),
		);
		return () => {
			live = false;
		};
	}, deps);
	return { value, error };
}
