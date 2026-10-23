import { registerPlugin } from "@capacitor/core";

export interface RecordedNotification {
	package: string;
	app: string;
	conversation?: string;
	sender?: string;
	title: string;
	text: string;
	time: number;
}

export interface ActiveNotification {
	key: string;
	app: string;
	title: string;
	text: string;
	time: number;
	canReply: boolean;
	clearable: boolean;
}

interface MediaSession {
	package: string;
	app: string;
	state: "playing" | "paused" | "buffering" | "stopped" | "none" | "other";
	title?: string;
	artist?: string;
	album?: string;
	durationMs?: number;
	positionMs?: number;
}

export type DndMode = "off" | "priority" | "alarms" | "silent";

export interface NotificationsPlugin {
	status(): Promise<{ allowed: boolean }>;
	openSettings(): Promise<void>;
	list(options: { since?: number; app?: string; query?: string; limit?: number }): Promise<{ items: RecordedNotification[] }>;
	clear(): Promise<void>;
	active(options: { app: string; conversation?: string }): Promise<{ items: ActiveNotification[] }>;
	reply(options: { key: string; text: string }): Promise<void>;
	dismiss(options: { keys: string[] }): Promise<void>;
	media(): Promise<{ items: MediaSession[] }>;
	mediaControl(options: { action: "play" | "pause" | "next" | "previous" | "stop"; package?: string }): Promise<{ package: string }>;
	dnd(): Promise<{ mode: DndMode | "unknown"; until: number }>;
	setDnd(options: { mode: DndMode; until?: number }): Promise<void>;
}

export const Notifications = registerPlugin<NotificationsPlugin>("Notifications");
