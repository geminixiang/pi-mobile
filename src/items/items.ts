import { type ConversationId, defineDoc } from "@earendil-works/pi-durable";
import { checkpointEvery64 } from "../agent/doc-policy.ts";
import { DAY, localTime } from "../agent/tools/common.ts";

export type Item = {
	id: string;
	title: string;
	bot: ConversationId;
	nextAt?: number;
	ref?: string;
	createdAt: number;
	updatedAt: number;
} & ({ state: "todo" } | { state: "waiting"; waitingOn: string } | { state: "done"; doneAt: number });

export const ItemDoc = defineDoc<{ items: Item[] }>({
	kind: "app.items",
	version: 1,
	scope: "session",
	initial: () => ({ items: [] }),
	checkpointWhen: checkpointEvery64,
});

export const ITEM_TRIGGER = "item:";
const DONE_KEPT_MS = 30 * DAY;

export const itemTrigger = (id: string) => `${ITEM_TRIGGER}${id}`;

export function pruned(items: readonly Item[], now: number): Item[] {
	return items.filter((item) => item.state !== "done" || item.doneAt > now - DONE_KEPT_MS);
}

export function described(item: Item): string {
	const state = item.state === "waiting" ? `waiting on ${item.waitingOn}` : item.state;
	return [item.id, item.title, state, item.nextAt !== undefined ? `next ${localTime(item.nextAt)}` : "no next time", item.ref].filter(Boolean).join(" · ");
}

export type Due = { conversation: string; bot: string; avatar: string; title: string; due?: number };

const AGENDA_KEPT = 10;

export function agenda<Id>(items: readonly { bot: Id; title: string; state: Item["state"]; nextAt?: number }[], bots: readonly { id: Id; name: string; avatar: string }[], endOfDay: number): Due[] {
	return items
		.filter((item) => item.state === "todo" && (item.nextAt === undefined || item.nextAt < endOfDay))
		.toSorted((a, b) => (a.nextAt ?? Number.MAX_SAFE_INTEGER) - (b.nextAt ?? Number.MAX_SAFE_INTEGER))
		.flatMap((item) => {
			const bot = bots.find((candidate) => candidate.id === item.bot);
			return bot ? [{ conversation: String(item.bot), bot: bot.name, avatar: bot.avatar, title: item.title, ...(item.nextAt !== undefined ? { due: item.nextAt } : {}) }] : [];
		})
		.slice(0, AGENDA_KEPT);
}
