import type { Context } from "@earendil-works/chord/context";
import { type ConversationId, defineDoc, type DocumentReader, defineExtension, GenerationTask, hook } from "@earendil-works/pi-durable";
import { appSection } from "./section.ts";
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
	removing?: { at: number };
	off?: string[];
	rhythmOffer?: RhythmOffer;
};

const RHYTHM_OFFER = ["unsent", "open", "last"] as const;
type RhythmOffer = (typeof RHYTHM_OFFER)[number];
export const NEW_BOT_OFFER: RhythmOffer = RHYTHM_OFFER[0];

export function afterUserMessage(offer: RhythmOffer): RhythmOffer | undefined {
	return RHYTHM_OFFER[RHYTHM_OFFER.indexOf(offer) + 1];
}

const OFFER =
	"[app] The user's first conversation with you: unless you already asked it above, after your answer end this reply with ask_user, question 「要我每天早上給你簡報嗎？」, options 好 and 不用; put any other choices in your text. Set nothing up unless they answer 好, then read the morning-brief skill.";

function offering(bot: Bot | undefined): boolean {
	return bot?.rhythmOffer === "open" || bot?.rhythmOffer === "last";
}

export const BotIndex = defineDoc<{ items: Bot[] }>({
	kind: "app.bots",
	version: 1,
	scope: "session",
	initial: () => ({ items: [] }),
	checkpointWhen: checkpointEvery64,
});

export async function botsIn(reader: Pick<DocumentReader, "snapshot">, context: Context): Promise<Bot[]> {
	return ((await reader.snapshot(BotIndex, context))?.items ?? []).filter((bot) => !bot.removing);
}

export const LeftFolders = defineDoc<{ items: { folder: string; computer: string }[] }>({
	kind: "app.left-folders",
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
	const uses = (id: string) => bots.filter((bot) => avatarOf(bot) === id).length;
	return AVATARS.reduce((least, avatar) => (uses(avatar.id) < uses(least.id) ? avatar : least)).id;
}

export const DEFAULT_BOT = { name: "pi", job: "", avatar: "helper" };
export const MAX_JOB = 1500;

export function botFields({ name, job }: { name: string; job: string }): { name: string; job: string } {
	if (!name.trim()) throw new Error("Bot 需要名字");
	if (job.length > MAX_JOB) throw new Error(`工作說明最多 ${MAX_JOB} 字`);
	return { name: name.trim(), job: job.trim() };
}

export const BotExtension = defineExtension({
	name: "bot",
	hooks: [
		hook(GenerationTask, {
			beforeRequest: async ({ messages }, api, context) => {
				const self = (await botsIn(api, context)).find((bot) => bot.id === api.conversationId);
				const last = messages.findLastIndex((message) => message.role === "user");
				const asked = messages[last];
				if (!offering(self) || asked?.role !== "user") return undefined;
				const content = typeof asked.content === "string" ? [{ type: "text" as const, text: asked.content }] : asked.content;
				if (content.some((part) => part.type === "text" && part.text.startsWith("[trigger]"))) return undefined;
				return { messages: messages.with(last, { ...asked, content: [...content, { type: "text" as const, text: OFFER }] }) };
			},
		}),
	],
	sections: [
		appSection("bot", 1_200, async (input, context) => {
			const bots = await botsIn(input.read, context);
			const self = bots.find((bot) => bot.id === input.conversationId);
			if (!self) return undefined;
			const others = bots.filter((bot) => bot.id !== self.id);
			return [
				`You are ${self.name}, one of the user's bots in this app. You keep one long conversation with the user; older parts are summarized automatically, so put what must last in your MEMORY.md.`,
				self.job ? `Your job:\n${self.job}` : "You are the user's general assistant.",
				others.length > 0
					? `The user's other bots (they cannot see this conversation): ${others.map((bot) => bot.name).join(", ")}. When a request clearly belongs to one of them, say so.`
					: "",
			]
				.filter(Boolean)
				.join("\n");
		}),
	],
});
