import { type ConversationId, defineDoc } from "@earendil-works/pi-durable";
import { checkpointEvery64 } from "../agent/doc-policy.ts";
import { DAY, localTime, soonest } from "../time.ts";
import type { When } from "../triggers/plugin.ts";

export type Item = ItemOf<ConversationId>;

type ItemOf<Bot> = {
	id: string;
	title: string;
	bot: Bot;
	nextAt?: number;
	ref?: string;
	createdAt: number;
	updatedAt: number;
} & ({ state: "todo" } | { state: "waiting"; waitingOn: string; wake?: Wake } | { state: "done"; doneAt: number });

type Wake = { app?: string; contains?: string };

export const ItemDoc = defineDoc<{ items: Item[] }>({
	kind: "app.items",
	version: 1,
	scope: "session",
	initial: () => ({ items: [] }),
	checkpointWhen: checkpointEvery64,
});

export const ITEM_TRIGGER = "item:";
export const REPLY_TRIGGER = "reply:";
const DONE_KEPT_MS = 30 * DAY;

export const itemTrigger = (id: string) => `${ITEM_TRIGGER}${id}`;
export const replyTrigger = (id: string) => `${REPLY_TRIGGER}${id}`;

export function schedulesOf<Bot>(item: ItemOf<Bot>, avatar: string | undefined, now: number): { id: string; name: string; when: When; avatar?: string }[] {
	if (item.state === "done") return [];
	const shown = avatar !== undefined ? { avatar } : {};
	const due = item.nextAt !== undefined ? [{ id: itemTrigger(item.id), name: item.title, when: { kind: "once" as const, at: Math.max(item.nextAt, now) }, ...shown }] : [];
	const reply = item.state === "waiting" && item.wake ? [{ id: replyTrigger(item.id), name: item.title, when: { kind: "notification" as const, ...item.wake, days: [], gapHours: 1 }, ...shown }] : [];
	return [...due, ...reply];
}

export function pruned(items: readonly Item[], now: number): Item[] {
	return items.filter((item) => item.state !== "done" || item.doneAt > now - DONE_KEPT_MS);
}

export function described(item: Item): string {
	const wake = item.state === "waiting" && item.wake ? `, wakes on a notification${item.wake.app ? ` from ${item.wake.app}` : ""}${item.wake.contains ? ` with "${item.wake.contains}"` : ""}` : "";
	const state = item.state === "waiting" ? `waiting on ${item.waitingOn}${wake}` : item.state;
	return [item.id, item.title, state, item.nextAt !== undefined ? `next ${localTime(item.nextAt)}` : "no next time", item.ref].filter(Boolean).join(" · ");
}

type Due = { item: string; conversation: string; bot: string; avatar: string; title: string; due?: number };

export function agenda<Id>(items: readonly { id: string; bot: Id; title: string; state: Item["state"]; nextAt?: number }[], bots: readonly { id: Id; name: string; avatar: string }[], endOfDay: number): Due[] {
	return items
		.filter((item) => item.state === "todo" && (item.nextAt === undefined || item.nextAt < endOfDay))
		.toSorted(soonest((item) => item.nextAt))
		.flatMap((item) => {
			const bot = bots.find((candidate) => candidate.id === item.bot);
			return bot ? [{ item: item.id, conversation: String(item.bot), bot: bot.name, avatar: bot.avatar, title: item.title, ...(item.nextAt !== undefined ? { due: item.nextAt } : {}) }] : [];
		});
}
