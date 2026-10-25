import { defineExtension } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Voice } from "../../voice-plugin.ts";
import { defineAppTool, text } from "./common.ts";

const MAX_CHARS = 3000;

const speak = defineAppTool({
	name: "speak",
	description:
		"Read text aloud to the user through the phone, or the headphones when connected. Resolves when it was spoken. Use it when the user is listening rather than reading (a headphones schedule, or when they ask to hear it). Read the spoken-report skill first and follow it: a read-out written report is too dense to follow by ear.",
	parameters: Type.Object({
		text: Type.String({ description: `What to say, at most ${MAX_CHARS} characters` }),
		language: Type.Optional(Type.String({ description: "BCP 47 tag of the text's language; default zh-TW" })),
	}),
	execute: async (args, _api, context) => {
		if (args.text.length > MAX_CHARS) throw new Error(`text is ${args.text.length} characters; keep it under ${MAX_CHARS}`);
		const stop = () => void Voice.stopSpeaking();
		context.abortSignal?.addEventListener("abort", stop, { once: true });
		try {
			const result = await Voice.speak({ text: args.text, language: args.language ?? "zh-TW" });
			if (result.spoken) return text("Spoken.");
			return { output: [{ type: "text", text: `Not finished: ${result.reason ?? "stopped"}. Do not speak it again unless the user asks.` }], isError: true };
		} finally {
			context.abortSignal?.removeEventListener("abort", stop);
		}
	},
});

export const SpeechExtension = defineExtension({ name: "speech", tools: [speak] });
