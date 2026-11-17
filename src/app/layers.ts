import { App } from "@capacitor/app";
import { useRef } from "react";
import { inApp } from "../native.ts";

const BACK_KEY = "pi-back";

if (inApp) {
	void App.addListener("backButton", () => {
		const top = [...document.querySelectorAll("[data-back]")].at(-1);
		if (top) top.dispatchEvent(new KeyboardEvent("keydown", { key: BACK_KEY, bubbles: true }));
		else void App.minimizeApp();
	});
}

export function isBack(event: { key: string; target: EventTarget; currentTarget: EventTarget }): boolean {
	return event.key === BACK_KEY && event.target === event.currentTarget;
}

export function useLast<T>(keep: boolean, value: T): T {
	const last = useRef(value);
	if (keep) last.current = value;
	return last.current;
}
