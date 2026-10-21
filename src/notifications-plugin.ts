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

export interface NotificationsPlugin {
	status(): Promise<{ allowed: boolean }>;
	openSettings(): Promise<void>;
	/** Newest first; all of them without `limit`. `app` matches the app's name or package, `query` the title, text, sender, or chat. */
	list(options: { since?: number; app?: string; query?: string; limit?: number }): Promise<{ items: RecordedNotification[] }>;
	clear(): Promise<void>;
}

export const Notifications = registerPlugin<NotificationsPlugin>("Notifications");
