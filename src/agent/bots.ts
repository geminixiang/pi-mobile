// Bots: the user's long-lived assistants (after Grok Bot). Each bot is one durable conversation that never ends,
// with a name, a job the model is told, its own MEMORY.md, its schedules, and a folder in the shared sandbox. Long
// conversations are kept affordable by automatic compaction (settings › 自動壓縮). Facts about the user that every bot
// should know live in the global MEMORY.md.
import { type ConversationId, defineDoc, defineExtension, section } from "@earendil-works/pi-durable";

// A type alias, not an interface: documents need JSON-assignable types.
export type Bot = {
	/** The bot's conversation. */
	id: ConversationId;
	name: string;
	/** What the bot is for and how it works; part of its system prompt. Empty for a general assistant. */
	job: string;
	/** Its folder in the shared sandbox, fixed when created so a rename does not move files. */
	folder: string;
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
});

export const DEFAULT_BOT = { name: "pi", job: "" };
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
