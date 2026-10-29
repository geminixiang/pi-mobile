import { Notifications } from "../plugins/notifications.ts";

export async function requireAccess(): Promise<void> {
	if (!(await Notifications.status()).allowed) {
		throw new Error("Notification access is off. Tell the user to turn it on in pi's 設定 › 手機 › 通知讀取; nothing can be done with notifications until then.");
	}
}
