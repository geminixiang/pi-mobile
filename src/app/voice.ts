import { native } from "../native.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { Voice } from "../plugins/voice.ts";
import { messageOf } from "../promise.ts";

type DictationState = "idle" | "starting" | "listening";

interface Dictation {
	supported: boolean;
	state: DictationState;
	partial: string;
	level: number;
	start: () => void;
	stop: () => void;
	cancel: () => void;
}

export function useDictation(onText: (text: string) => void, onError: (message: string) => void): Dictation {
	const [supported, setSupported] = useState(false);
	const [state, setState] = useState<DictationState>("idle");
	const [partial, setPartial] = useState("");
	const [level, setLevel] = useState(0);
	const callbacks = useRef({ onText, onError });
	callbacks.current = { onText, onError };

	useEffect(() => {
		if (!native.has("Voice")) return;
		void Voice.available().then(({ available }) => setSupported(available));
		const handles = [
			Voice.addListener("ready", () => setState("listening")),
			Voice.addListener("partial", ({ text }) => setPartial(text)),
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
			callbacks.current.onError(messageOf(error));
		});
	}, []);
	const stop = useCallback(() => void Voice.stop(), []);
	const cancel = useCallback(() => void Voice.cancel(), []);
	return { supported, state, partial, level, start, stop, cancel };
}
