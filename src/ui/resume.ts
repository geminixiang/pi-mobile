import { App } from "@capacitor/app";
import { useEffect } from "react";

export function useOnResume(refresh: () => void): void {
	useEffect(() => {
		refresh();
		const listener = App.addListener("resume", refresh);
		return () => void listener.then((handle) => handle.remove());
	}, []);
}
