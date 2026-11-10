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
		"Ask the user one question with 2 to 4 answers shown as buttons they tap; they can also type their own. Use it only when you cannot go on without their choice or consent, not for open questions. Before asking them to approve something you will send, post, or delete, show all of it in your reply first and say what changed since they last saw it. When their next message is not an answer, reply to it in text and do not call ask_user in that reply. Call it last and alone: the card ends your turn.",
	parameters: AskArgs,
	execute: async () => ({ ...text("Shown to the user as a card with those buttons. If their next message answers it, go on; if it is about something else, reply to that in text and do not ask again in that reply."), control: { terminate: true } }),
});

export const InteractionExtension = defineExtension({ name: "interaction", tools: [askUser] });

export const isInteraction = (tool: string): boolean => InteractionExtension.tools?.some((registered) => registered.name === tool) ?? false;
