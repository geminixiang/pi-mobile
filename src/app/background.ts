import { native } from "../native.ts";
import { KeepAlive } from "../plugins/keep-alive.ts";
import { resumed } from "../ui/resume.ts";
import { useStore } from "../ui/subscribed.ts";

type Background = { notifications: boolean; unrestrictedBattery?: boolean };

export function useBackground(): { status: Background | undefined; allowNotifications: () => void; unrestrictBattery: () => void } {
	const [status, setStatus] = useStore<Background | undefined>(undefined, resumed(native.has("KeepAlive") ? () => KeepAlive.status() : undefined), []);
	return {
		status,
		allowNotifications: () =>
			void KeepAlive.requestNotifications()
				.then(() => KeepAlive.status())
				.then(setStatus),
		unrestrictBattery: () => void KeepAlive.requestUnrestrictedBattery(),
	};
}
