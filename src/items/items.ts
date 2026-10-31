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
