// Bots: the user's long-lived assistants (after Grok Bot). Each bot is one durable conversation that never ends,
// with a name, a job the model is told, its own MEMORY.md, its schedules, and a folder in the shared sandbox. Long
// conversations are kept affordable by automatic compaction (settings › 自動壓縮). Facts about the user that every bot
// should know live in the global MEMORY.md.
import { type ConversationId, defineDoc, defineExtension, section } from "@earendil-works/pi-durable";
import { checkpointEvery64 } from "./doc-policy.ts";

// A type alias, not an interface: documents need JSON-assignable types.
export type Bot = {
	/** The bot's conversation. */
	id: ConversationId;
	name: string;
	/** What the bot is for and how it works; part of its system prompt. Empty for a general assistant. */
	job: string;
	/** Its folder in the shared sandbox, fixed when created so a rename does not move files. */
	folder: string;
	/** One of AVATARS; bots from before avatars have none and show the first. */
	avatar?: string;
	createdAt: number;
	/** Last message, for the list's order. */
	updatedAt: number;
};

/** The bots, in no particular order; the app sorts them. */
export const BotIndex = defineDoc<{ items: Bot[] }>({
	kind: "app.bots",
	version: 1,
	scope: "session",
	initial: () => ({ items: [] }),
	checkpointWhen: checkpointEvery64,
});

/** The avatar set (public/avatars/<id>.webp), pixel heads in the pi mark's palette, each with a role's prop. */
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

/** The first avatar no bot has yet, for a new bot's form. */
export function freeAvatar(bots: readonly Bot[]): string {
	return (AVATARS.find((avatar) => !bots.some((bot) => avatarOf(bot) === avatar.id)) ?? AVATARS[0]).id;
}

export const DEFAULT_BOT = { name: "pi", job: "", avatar: "helper" };
export const MAX_BOTS = 12;
export const MAX_JOB = 1500;

/** An ASCII folder name for a bot: its name when that is ASCII, else bot-<n>; never one already taken. */
export function folderFor(name: string, taken: readonly string[]): string {
	const ascii = name
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 24);
	if (ascii && !taken.includes(ascii)) return ascii;
	const base = ascii || "bot";
	for (let n = ascii ? 2 : 1; ; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
}

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
