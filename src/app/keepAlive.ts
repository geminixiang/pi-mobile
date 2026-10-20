// Keeps runs going while the app is in the background or the screen is locked (AgentService on Android), and tells
// the user when a run finishes or needs approval while they are away.
import { App } from "@capacitor/app";
import { Capacitor, registerPlugin } from "@capacitor/core";

interface KeepAlivePlugin {
	/** Starts the service, or updates its notification; the title defaults to "pi 工作中". */
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

/** Whether the user is looking at the app. */
export function inForeground(): boolean {
	return active;
}

let running = false;
let workingTitles: string[] = [];
/** What a tool asks the user to approve while pi is away; shown instead of "working" until it is answered. */
const waiting = new Map<string, string>();

function showWorking(): void {
	const [question] = waiting.values();
	if (question !== undefined) {
		void KeepAlive.start({ title: "pi 等你確認", text: question });
		return;
	}
	void KeepAlive.start({ text: workingTitles.length === 1 ? (workingTitles[0] ?? "") : `${workingTitles.length} 個對話執行中` });
}

/**
 * While an approval waits, the working notification says so. Samsung bundles pi's notifications, and collapsed, only
 * the top one (the working notification) shows; this way the user sees pi waits for them without expanding it.
 * Returns the function that ends the wait.
 */
export function showWaiting(question: string): () => void {
	if (!native || !running) return () => undefined;
	const id = crypto.randomUUID();
	waiting.set(id, question);
	showWorking();
	return () => {
		waiting.delete(id);
		if (running) showWorking();
	};
}
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
	workingTitles = titles;
	// Ask once, when it first matters: without it the "working" and "done" notifications stay hidden.
	if (!localStorage.getItem(ASKED_KEY)) {
		localStorage.setItem(ASKED_KEY, "1");
		void KeepAlive.requestNotifications();
	}
	showWorking();
}

/** Stop the foreground service a fired schedule started natively, when no run followed it. */
export function releaseIfIdle(): void {
	if (native && !running) void KeepAlive.stop();
}

/** Notify only while the app is not in front; in front, the screen already shows it. */
export function notifyAway(title: string, text: string): void {
	if (native && !active) void KeepAlive.notify({ title, text });
}
