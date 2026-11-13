import { App } from "@capacitor/app";
import { useEffect, useState } from "react";
import { native, type NativePlugin } from "../native.ts";
import { KeepAlive } from "../plugins/keep-alive.ts";

export function useRefreshOnResume(plugin: NativePlugin, refresh: () => void): void {
	useEffect(() => {
		if (!native.has(plugin)) return;
		refresh();
		const listener = App.addListener("resume", refresh);
		return () => void listener.then((handle) => handle.remove());
	}, []);
}

export type Background = { notifications: boolean; unrestrictedBattery?: boolean };

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
