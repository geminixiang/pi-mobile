import { useState } from "react";
import { native, type NativePlugin } from "../native.ts";
import { KeepAlive } from "../plugins/keep-alive.ts";
import { useOnResume } from "../ui/resume.ts";

export function useRefreshOnResume(plugin: NativePlugin, refresh: () => void): void {
	useOnResume(() => {
		if (native.has(plugin)) refresh();
	});
}

type Background = { notifications: boolean; unrestrictedBattery?: boolean };

export function useBackground(): { status: Background | undefined; allowNotifications: () => void; unrestrictBattery: () => void } {
	const [status, setStatus] = useState<Background>();
	const refresh = () => void KeepAlive.status().then(setStatus);
	useRefreshOnResume("KeepAlive", refresh);
	return {
		status,
		allowNotifications: () => void KeepAlive.requestNotifications().then(refresh),
		unrestrictBattery: () => void KeepAlive.requestUnrestrictedBattery(),
	};
}
