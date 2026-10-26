import { type DependencyList, useEffect, useState } from "react";
import { messageOf } from "../promise.ts";

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
