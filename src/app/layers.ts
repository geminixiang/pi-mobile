import { App } from "@capacitor/app";
import { inApp } from "../native.ts";
import { useCallback, useRef, useSyncExternalStore } from "react";

const stack: (() => void)[] = [];

if (inApp) {
	void App.addListener("backButton", () => {
		const top = stack.at(-1);
		if (top) top();
		else void App.minimizeApp();
	});
}

const unheard = () => undefined;

export function useBack(active: boolean, onBack: () => void): void {
	const latest = useRef(onBack);
	latest.current = onBack;
	const listen = useCallback(() => {
		if (!active) return unheard;
		const entry = () => latest.current();
		stack.push(entry);
		return () => {
			const index = stack.indexOf(entry);
			if (index !== -1) stack.splice(index, 1);
		};
	}, [active]);
	useSyncExternalStore(listen, unheard);
}

export function useLast<T>(keep: boolean, value: T): T {
	const last = useRef(value);
	if (keep) last.current = value;
	return last.current;
}
