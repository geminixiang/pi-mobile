import type { Network } from "./resumable-socket.ts";

export const deviceNetwork: Network = {
	online: () => typeof navigator === "undefined" || navigator.onLine !== false,
	onChange: (listener) => {
		if (typeof window === "undefined" || typeof document === "undefined") return () => undefined;
		const visible = () => {
			if (document.visibilityState === "visible") listener();
		};
		window.addEventListener("online", listener);
		window.addEventListener("offline", listener);
		document.addEventListener("visibilitychange", visible);
		return () => {
			window.removeEventListener("online", listener);
			window.removeEventListener("offline", listener);
			document.removeEventListener("visibilitychange", visible);
		};
	},
};
