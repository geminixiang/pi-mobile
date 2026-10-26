import { App } from "@capacitor/app";
import { registerPlugin } from "@capacitor/core";
import { native } from "../native.ts";
import { orLogged } from "../promise.ts";

interface KeepAlivePlugin {
	start(options: { text: string; title?: string }): Promise<void>;
	stop(): Promise<void>;
	notify(options: { title: string; text: string }): Promise<void>;
	clearNotification(): Promise<void>;
	status(): Promise<{ notifications: boolean; unrestrictedBattery?: boolean }>;
	requestNotifications(): Promise<{ granted: boolean }>;
	requestUnrestrictedBattery(): Promise<void>;
}

export const KeepAlive = registerPlugin<KeepAlivePlugin>("KeepAlive");
const available = native.has("KeepAlive");

let active = true;
if (available) {
	void App.addListener("appStateChange", ({ isActive }) => {
		active = isActive;
		if (isActive) void KeepAlive.clearNotification();
	});
}

export function inForeground(): boolean {
	return active;
}

let running = false;

const ASKED_KEY = "pi-mobile.notificationsAsked";

export function setWorking(titles: string[]): void {
	if (!available) return;
	if (titles.length === 0) {
		if (running) void KeepAlive.stop();
		running = false;
		return;
	}
	running = true;
	if (!localStorage.getItem(ASKED_KEY)) {
		localStorage.setItem(ASKED_KEY, "1");
		void KeepAlive.requestNotifications();
	}
	void orLogged(KeepAlive.start({ text: titles.length === 1 ? (titles[0] ?? "") : `${titles.length} 個對話執行中` }), "keep_alive.start_failed", undefined);
}

export function releaseIfIdle(): void {
	if (available && !running) void KeepAlive.stop();
}

export function notifyAway(title: string, text: string): void {
	if (available && !active) void KeepAlive.notify({ title, text });
}
