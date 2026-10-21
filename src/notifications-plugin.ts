// NotificationsPlugin on Android: the notifications other apps showed, recorded on the phone once the user allows
// notification access (NotificationsListener.java), for the read_notifications tool and settings.
import { registerPlugin } from "@capacitor/core";

export interface RecordedNotification {
	package: string;
	app: string;
	/** A chat's name (a group, or the person in a one-to-one chat). */
	conversation?: string;
	/** Who wrote a chat message. */
	sender?: string;
	title: string;
	text: string;
	/** Milliseconds since the epoch. */
	time: number;
}

/** A notification in the shade now. */
export interface ActiveNotification {
	key: string;
	app: string;
	title: string;
	text: string;
	time: number;
	/** It has a reply action that takes typed text (a chat). */
	canReply: boolean;
	clearable: boolean;
}

export interface MediaSession {
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
	/** Newest first; all of them without `limit`. `app` matches the app's name or package, `query` the title, text, sender, or chat. */
	list(options: { since?: number; app?: string; query?: string; limit?: number }): Promise<{ items: RecordedNotification[] }>;
	clear(): Promise<void>;
	/** These need the listener connected (notification access on); they reject otherwise. */
	active(options: { app: string; conversation?: string }): Promise<{ items: ActiveNotification[] }>;
	reply(options: { key: string; text: string }): Promise<void>;
	dismiss(options: { keys: string[] }): Promise<void>;
	media(): Promise<{ items: MediaSession[] }>;
	mediaControl(options: { action: "play" | "pause" | "next" | "previous" | "stop"; package?: string }): Promise<{ package: string }>;
	dnd(): Promise<{ mode: DndMode | "unknown"; until: number }>;
	/** With `until` (ms), it ends then by itself. */
	setDnd(options: { mode: DndMode; until?: number }): Promise<void>;
}

export const Notifications = registerPlugin<NotificationsPlugin>("Notifications");
