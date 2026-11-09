import { defineExtension } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { defineAppTool, text } from "../agent/tools/common.ts";

export const ASK_USER = "ask_user";

export const AskArgs = Type.Object({
	question: Type.String({ description: "One short question in the user's language" }),
	options: Type.Array(Type.String({ description: "An answer the user can tap, a few words, written as the user would say it" }), {
		minItems: 2,
		maxItems: 4,
		description: "2 to 4 answers, the likeliest first",
	}),
});

const askUser = defineAppTool({
	name: ASK_USER,
	groups: "always",
	effect: "read",
	reach: "model",
	callers: ["model"],
	description:
		"Ask the user one question with 2 to 4 answers shown as buttons they tap; they can also type their own. Use it whenever you need the user to choose or confirm before going on (which one first, which time, whether to go ahead), instead of listing the choices in your reply. Not for open questions with no natural answers. Then end your turn.",
	parameters: AskArgs,
	execute: async () =>
		text("Shown to the user as a card with those buttons. End your turn now, without repeating the question or the answers; the user's answer comes as their next message."),
});

export const InteractionExtension = defineExtension({ name: "interaction", tools: [askUser] });

export const isInteraction = (tool: string): boolean => InteractionExtension.tools?.some((registered) => registered.name === tool) ?? false;
