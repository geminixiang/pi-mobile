import { type ConversationId, defineDoc, defineExtension, section } from "@earendil-works/pi-durable";
import { uuidv7 } from "@earendil-works/pi-ai/utils/uuid";
import { checkpointEvery64 } from "./doc-policy.ts";

export type Bot = {
	id: ConversationId;
	name: string;
	job: string;
	folder: string;
	computer?: string;
	avatar?: string;
	createdAt: number;
	updatedAt: number;
};

export const BotIndex = defineDoc<{ items: Bot[] }>({
	kind: "app.bots",
	version: 1,
	scope: "session",
	initial: () => ({ items: [] }),
	checkpointWhen: checkpointEvery64,
});

export const AVATARS = [
	{ id: "helper", label: "助手" },
	{ id: "secretary", label: "秘書" },
	{ id: "researcher", label: "研究" },
	{ id: "coder", label: "程式" },
	{ id: "writer", label: "寫作" },
	{ id: "finance", label: "理財" },
	{ id: "traveler", label: "旅行" },
	{ id: "mail", label: "信件" },
	{ id: "news", label: "新聞" },
	{ id: "home", label: "居家" },
	{ id: "health", label: "健康" },
	{ id: "owl", label: "提醒" },
] as const;

export function avatarOf(bot: Pick<Bot, "avatar">): string {
	return AVATARS.find((avatar) => avatar.id === bot.avatar)?.id ?? AVATARS[0].id;
}

export function freeAvatar(bots: readonly Bot[]): string {
	return (AVATARS.find((avatar) => !bots.some((bot) => avatarOf(bot) === avatar.id)) ?? AVATARS[0]).id;
}

export const DEFAULT_BOT = { name: "pi", job: "", avatar: "helper" };
export const MAX_BOTS = 12;
export const MAX_JOB = 1500;

export const newFolder = (): string => uuidv7();

export const BotExtension = defineExtension({
	name: "bot",
	sections: [
		section("bot", async (input, context) => {
			const bots = (await input.read.snapshot(BotIndex, context))?.items ?? [];
			const self = bots.find((bot) => bot.id === input.conversationId);
			if (!self) return undefined;
			const others = bots.filter((bot) => bot.id !== self.id);
			return [
				`You are ${self.name}, one of the user's bots in this app. You keep one long conversation with the user; older parts are summarized automatically, so put what must last in your MEMORY.md.`,
				self.job ? `Your job:\n${self.job}` : "You are the user's general assistant.",
				others.length > 0
					? `The user's other bots (they cannot see this conversation): ${others.map((bot) => `${bot.name}${bot.job ? ` (${bot.job.split("\n")[0]?.slice(0, 80)})` : ""}`).join("; ")}. When a request clearly belongs to one of them, say so.`
					: "",
			]
				.filter(Boolean)
				.join("\n");
		}),
	],
});
