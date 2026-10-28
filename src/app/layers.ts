import { App } from "@capacitor/app";
import { inApp } from "../native.ts";
import { useEffect, useEffectEvent } from "react";

const stack: (() => void)[] = [];

if (inApp) {
	void App.addListener("backButton", () => {
		const top = stack.at(-1);
		if (top) top();
		else void App.minimizeApp();
	});
}

export function useBack(active: boolean, onBack: () => void): void {
	const back = useEffectEvent(onBack);
	useEffect(() => {
		if (!active) return;
		const entry = () => back();
		stack.push(entry);
		return () => {
			const index = stack.indexOf(entry);
			if (index !== -1) stack.splice(index, 1);
		};
	}, [active]);
}
