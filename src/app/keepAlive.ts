// Keeps runs going while the app is in the background or the screen is locked (AgentService on Android), and tells
// the user when a run finishes or needs approval while they are away.
import { App } from "@capacitor/app";
import { Capacitor, registerPlugin } from "@capacitor/core";

interface KeepAlivePlugin {
	start(options: { text: string }): Promise<void>;
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

/** Whether the user is looking at the app. */
export function inForeground(): boolean {
	return active;
}

let running = false;
const ASKED_KEY = "pi-mobile.notificationsAsked";

/** Start, update, or stop the foreground service for the conversations that are working. */
export function setWorking(titles: string[]): void {
	if (!native) return;
	if (titles.length === 0) {
		if (running) void KeepAlive.stop();
		running = false;
		return;
	}
	running = true;
	// Ask once, when it first matters: without it the "working" and "done" notifications stay hidden.
	if (!localStorage.getItem(ASKED_KEY)) {
		localStorage.setItem(ASKED_KEY, "1");
		void KeepAlive.requestNotifications();
	}
	void KeepAlive.start({ text: titles.length === 1 ? (titles[0] ?? "") : `${titles.length} 個對話執行中` });
}

/** Stop the foreground service a fired schedule started natively, when no run followed it. */
export function releaseIfIdle(): void {
	if (native && !running) void KeepAlive.stop();
}

/** Notify only while the app is not in front; in front, the screen already shows it. */
export function notifyAway(title: string, text: string): void {
	if (native && !active) void KeepAlive.notify({ title, text });
}
