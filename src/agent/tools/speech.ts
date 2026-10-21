// speak: read text aloud with the phone's text-to-speech, for reports the user hears rather than reads, such as a
// headphones schedule's briefing. Plays through whatever is connected; other audio is ducked meanwhile.
import { Capacitor } from "@capacitor/core";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Voice } from "../../voice-plugin.ts";

/** About ten minutes of speech; a report longer than that should be shorter. */
const MAX_CHARS = 3000;

const speak = defineTool({
	name: "speak",
	description:
		"Read text aloud to the user through the phone, or the headphones when connected. Resolves when it was spoken. Use it when the user is listening rather than reading (a headphones schedule, or when they ask to hear it). Read the spoken-report skill first and follow it: a read-out written report is too dense to follow by ear.",
	parameters: Type.Object({
		text: Type.String({ description: `What to say, at most ${MAX_CHARS} characters` }),
		language: Type.Optional(Type.String({ description: "BCP 47 tag of the text's language; default zh-TW" })),
	}),
	execute: async (args, _api, context) => {
		if (!Capacitor.isNativePlatform()) throw new Error("only available in the Android app");
		if (args.text.length > MAX_CHARS) throw new Error(`text is ${args.text.length} characters; keep it under ${MAX_CHARS}`);
		const stop = () => void Voice.stopSpeaking();
		context.abortSignal?.addEventListener("abort", stop, { once: true });
		try {
			const result = await Voice.speak({ text: args.text, language: args.language ?? "zh-TW" });
			if (result.spoken) return { output: [{ type: "text", text: "Spoken." }] };
			// Stopped by the user (headphones out, stop button): not worth repeating aloud.
			return { output: [{ type: "text", text: `Not finished: ${result.reason ?? "stopped"}. Do not speak it again unless the user asks.` }], isError: true };
		} finally {
			context.abortSignal?.removeEventListener("abort", stop);
		}
	},
});

export const SpeechExtension = defineExtension({ name: "speech", tools: [speak] });
