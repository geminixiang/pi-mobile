import { native } from "../native.ts";
import { useCallback, useRef } from "react";
import { Voice } from "../plugins/voice.ts";
import { messageOf } from "../promise.ts";
import { useStore } from "../ui/subscribed.ts";
import { haptic } from "./haptics.ts";

type DictationState = "idle" | "starting" | "listening";

type Heard = { supported: boolean; state: DictationState; partial: string; level: number };

const SILENT: Heard = { supported: false, state: "idle", partial: "", level: 0 };

interface Dictation extends Heard {
	start: () => void;
	stop: () => void;
	cancel: () => void;
}

export function useDictation(onText: (text: string) => void, onError: (message: string) => void): Dictation {
	const callbacks = useRef({ onText, onError });
	callbacks.current = { onText, onError };
	const [heard, setHeard] = useStore(
		SILENT,
		(set) => {
			if (!native.has("Voice")) return undefined;
			const hear = (change: Partial<Heard>) => set((current) => ({ ...current, ...change }));
			void Voice.available().then(({ available }) => hear({ supported: available }));
			const handles = [
				Voice.addListener("ready", () => hear({ state: "listening" })),
				Voice.addListener("partial", ({ text }) => hear({ partial: text })),
				Voice.addListener("level", ({ rms }) => hear({ level: Math.max(0, Math.min(1, (rms + 2) / 12)) })),
				Voice.addListener("final", ({ text }) => {
					if (text.trim()) callbacks.current.onText(text.trim());
				}),
				Voice.addListener("error", ({ message }) => callbacks.current.onError(message)),
				Voice.addListener("end", () => hear({ state: "idle", partial: "", level: 0 })),
			];
			return () => {
				for (const handle of handles) void handle.then((h) => h.remove());
				void Voice.cancel();
			};
		},
		[],
	);

	const start = useCallback(() => {
		haptic("press");
		setHeard((current) => ({ ...current, state: "starting", partial: "" }));
		Voice.start({ language: "zh-TW" }).catch((error: unknown) => {
			setHeard((current) => ({ ...current, state: "idle" }));
			callbacks.current.onError(messageOf(error));
		});
	}, []);
	const stop = useCallback(() => void Voice.stop(), []);
	const cancel = useCallback(() => void Voice.cancel(), []);
	return { ...heard, start, stop, cancel };
}
