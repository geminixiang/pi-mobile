import { App } from "@capacitor/app";
import { inApp } from "../native.ts";
import { useEffect, useRef } from "react";

const stack: (() => void)[] = [];
Object.assign(globalThis, { piLayers: stack });

if (inApp) {
	void App.addListener("backButton", () => {
		const top = stack.at(-1);
		if (top) top();
		else void App.minimizeApp();
	});
}

export function useBack(active: boolean, onBack: () => void): void {
	const latest = useRef(onBack);
	latest.current = onBack;
	useEffect(() => {
		if (!active) return;
		const entry = () => latest.current();
		stack.push(entry);
		return () => {
			const index = stack.indexOf(entry);
			if (index !== -1) stack.splice(index, 1);
		};
	}, [active]);
}
