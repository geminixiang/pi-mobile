// Dictation with the system speech recognizer (VoicePlugin on Android). The recognized text goes into the composer
// for the user to check and send; nothing is sent by voice alone.
import type { PluginListenerHandle } from "@capacitor/core";
import { Capacitor } from "@capacitor/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { Voice } from "../voice-plugin.ts";

export type DictationState = "idle" | "starting" | "listening";

export interface Dictation {
	supported: boolean;
	state: DictationState;
	/** Words recognized so far in this session. */
	partial: string;
	/** Microphone level from 0 to 1, for the meter. */
	level: number;
	start: () => void;
	stop: () => void;
	cancel: () => void;
}

/** `onText` receives the final text of each session; `onError` a short message to show. */
export function useDictation(onText: (text: string) => void, onError: (message: string) => void): Dictation {
	const [supported, setSupported] = useState(false);
	const [state, setState] = useState<DictationState>("idle");
	const [partial, setPartial] = useState("");
	const [level, setLevel] = useState(0);
	const callbacks = useRef({ onText, onError });
	callbacks.current = { onText, onError };

	useEffect(() => {
		if (!Capacitor.isNativePlatform()) return;
		void Voice.available().then(({ available }) => setSupported(available));
		const handles = [
			Voice.addListener("ready", () => setState("listening")),
			Voice.addListener("partial", ({ text }) => setPartial(text)),
			// rmsdB runs from about -2 (silence) to 10 (loud speech).
			Voice.addListener("level", ({ rms }) => setLevel(Math.max(0, Math.min(1, (rms + 2) / 12)))),
			Voice.addListener("final", ({ text }) => {
				if (text.trim()) callbacks.current.onText(text.trim());
			}),
			Voice.addListener("error", ({ message }) => callbacks.current.onError(message)),
			Voice.addListener("end", () => {
				setState("idle");
				setPartial("");
				setLevel(0);
			}),
		];
		return () => {
			for (const handle of handles) void handle.then((h) => h.remove());
			void Voice.cancel();
		};
	}, []);

	const start = useCallback(() => {
		setState("starting");
		setPartial("");
		Voice.start({ language: "zh-TW" }).catch((error: unknown) => {
			setState("idle");
			callbacks.current.onError(error instanceof Error ? error.message : String(error));
		});
	}, []);
	const stop = useCallback(() => void Voice.stop(), []);
	const cancel = useCallback(() => void Voice.cancel(), []);
	return { supported, state, partial, level, start, stop, cancel };
}
