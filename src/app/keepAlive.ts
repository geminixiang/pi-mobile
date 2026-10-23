import { App } from "@capacitor/app";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { log } from "../log.ts";
import { messageOf } from "../promise.ts";

interface KeepAlivePlugin {
	start(options: { text: string; title?: string }): Promise<void>;
	stop(): Promise<void>;
	notify(options: { title: string; text: string }): Promise<void>;
	clearNotification(): Promise<void>;
	status(): Promise<{ notifications: boolean; unrestrictedBattery: boolean }>;
	requestNotifications(): Promise<{ granted: boolean }>;
	requestUnrestrictedBattery(): Promise<void>;
}

export const KeepAlive = registerPlugin<KeepAlivePlugin>("KeepAlive");
export const native = Capacitor.isNativePlatform();

let active = true;
if (native) {
	void App.addListener("appStateChange", ({ isActive }) => {
		active = isActive;
		if (isActive) void KeepAlive.clearNotification();
	});
}

export function inForeground(): boolean {
	return active;
}

let running = false;
let workingTitles: string[] = [];

function startService(options: { text: string; title?: string }): void {
	KeepAlive.start(options).catch((error: unknown) => log.warn("keep_alive.start_failed", { error: messageOf(error) }));
}

function showWorking(): void {
	startService({ text: workingTitles.length === 1 ? (workingTitles[0] ?? "") : `${workingTitles.length} 個對話執行中` });
}

const ASKED_KEY = "pi-mobile.notificationsAsked";

export function setWorking(titles: string[]): void {
	if (!native) return;
	if (titles.length === 0) {
		if (running) void KeepAlive.stop();
		running = false;
		return;
	}
	running = true;
	workingTitles = titles;
	if (!localStorage.getItem(ASKED_KEY)) {
		localStorage.setItem(ASKED_KEY, "1");
		void KeepAlive.requestNotifications();
	}
	showWorking();
}

export function releaseIfIdle(): void {
	if (native && !running) void KeepAlive.stop();
}

export function notifyAway(title: string, text: string): void {
	if (native && !active) void KeepAlive.notify({ title, text });
}
