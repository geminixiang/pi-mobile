import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, ToolExecutionApi } from "@earendil-works/pi-durable";
import { editTriggers } from "./edit.ts";
import { Triggers } from "./plugin.ts";
import type { Trigger } from "./runs.ts";
import type { TriggerHost } from "./tool.ts";
import { native } from "../native.ts";
import { MINUTE } from "../time.ts";
import { randomHex } from "../encoding.ts";

export function isWatch(item: Trigger, agent: string, conversationId: ConversationId): boolean {
	return item.kind === "watch" && item.agent === agent && item.conversationId === conversationId;
}

export async function watch(triggers: TriggerHost, api: ToolExecutionApi, context: Context, watching: { agent: string; name: string; prompt: string }): Promise<boolean> {
	if (!native.implements(Triggers.sync)) return false;
	const now = Date.now();
	const trigger: Trigger = {
		id: randomHex(4),
		name: watching.name,
		prompt: watching.prompt,
		when: { kind: "once", at: now + MINUTE },
		kind: "watch",
		agent: watching.agent,
		conversationId: api.conversationId,
		state: "on",
		createdAt: now,
	};
	await editTriggers(api, context, triggers, (items) => [...items.filter((item) => !isWatch(item, watching.agent, api.conversationId)), trigger]);
	return true;
}
