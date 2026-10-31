import type { Context } from "@earendil-works/chord";
import { defineExtension, section, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { oneOf } from "../agent/parse.ts";
import { defineAppTool, parseLocalTime, text } from "../agent/tools/common.ts";
import type { TriggerHost } from "../triggers/tool.ts";
import { described, type Item, ItemDoc, pruned } from "./items.ts";

const STATES = ["todo", "waiting", "done"] as const;
const MORNING = 9;
const NO_TIME = "none";

function nextAtOf(value: string, now: number): number | undefined {
	if (value.trim() === NO_TIME) return undefined;
	const { ms, hasTime } = parseLocalTime(value, "next_at");
	const at = hasTime ? ms : new Date(ms).setHours(MORNING, 0, 0, 0);
	if (at <= now) throw new Error(`next_at ${value} is already past: give a later local time`);
	return at;
}

export function createItemsExtension(triggers: TriggerHost) {
	const save = async (api: ToolExecutionApi, context: Context, edit: (items: Item[]) => Item[]): Promise<void> => {
		await api.commit(async (tx) => {
			const doc = await tx.doc(ItemDoc);
			doc.items = pruned(edit(doc.items), Date.now());
		}, context);
		triggers.changed();
	};

	const noteItem = defineAppTool({
		name: "note_item",
		effect: "direct",
		description:
			"Keep one thing the user will need to come back to (a due date, waiting on someone or on a condition), shared by all bots: give id to update or close it, leave id out for a new one. " +
			"At next_at the phone wakes you here with it, so give one unless nothing should bring it back.",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "The item's id from list_items, to update it" })),
			title: Type.Optional(Type.String({ description: "One sentence the user understands, in their language; needed for a new item" })),
			state: Type.Optional(oneOf(STATES, { description: "todo: someone has to act; waiting: on a person or condition (give waiting_on); done: closed. Default todo" })),
			next_at: Type.Optional(Type.String({ description: `When to look at it again: local YYYY-MM-DD HH:MM, or a date for ${MORNING}:00 that day, or "${NO_TIME}"` })),
			waiting_on: Type.Optional(Type.String({ description: "Who or what it waits on, for state waiting" })),
			ref: Type.Optional(Type.String({ description: "Where the details are: a link, or a record in a bot's own data" })),
		}),
		execute: async (args, api, context) => {
			const now = Date.now();
			const nextAt = args.next_at === undefined ? undefined : nextAtOf(args.next_at, now);
			const existing = args.id === undefined ? undefined : (await api.snapshot(ItemDoc, context))?.items.find((item) => item.id === args.id);
			if (args.id !== undefined && !existing) throw new Error(`No item ${args.id}: take an id from list_items, or leave id out for a new item.`);
			const title = args.title ?? existing?.title;
			if (!title) throw new Error("A new item needs a title.");
			const state = args.state ?? existing?.state ?? "todo";
			const waitingOn = args.waiting_on ?? (existing?.state === "waiting" ? existing.waitingOn : undefined);
			if (state === "waiting" && !waitingOn) throw new Error("A waiting item needs waiting_on: who or what it waits on.");
			const base = {
				id: existing?.id ?? crypto.randomUUID().slice(0, 6),
				title,
				bot: existing?.bot ?? api.conversationId,
				...(args.next_at !== undefined ? (nextAt !== undefined ? { nextAt } : {}) : existing?.nextAt !== undefined && state !== "done" ? { nextAt: existing.nextAt } : {}),
				...((args.ref ?? existing?.ref) ? { ref: args.ref ?? existing?.ref } : {}),
				createdAt: existing?.createdAt ?? now,
				updatedAt: now,
			};
			const item: Item = state === "waiting" && waitingOn ? { ...base, state, waitingOn } : state === "done" ? { ...base, state, doneAt: now } : { ...base, state: "todo" };
			await save(api, context, (items) => [...items.filter((candidate) => candidate.id !== item.id), item]);
			const lone = item.state !== "done" && item.nextAt === undefined ? " Nothing will bring it back: give next_at unless the user will." : "";
			return text(`Item ${described(item)}.${lone}`);
		},
	});

	const listItems = defineAppTool({
		name: "list_items",
		effect: "read",
		description: "The open items: what is due, what waits on someone, what has no next time; this bot's by default, every bot's with all.",
		parameters: Type.Object({
			all: Type.Optional(Type.Boolean({ description: "Every bot's items, not only this bot's" })),
			done: Type.Optional(Type.Boolean({ description: "Also the items closed in the last 30 days" })),
		}),
		replay: "safe",
		execute: async (args, api, context) => {
			const items = ((await api.snapshot(ItemDoc, context))?.items ?? [])
				.filter((item) => args.all || item.bot === api.conversationId)
				.filter((item) => args.done || item.state !== "done")
				.toSorted((a, b) => (a.nextAt ?? Number.MAX_SAFE_INTEGER) - (b.nextAt ?? Number.MAX_SAFE_INTEGER));
			return text(items.length > 0 ? items.map(described).join("\n") : "No open items.");
		},
	});

	return defineExtension({
		name: "items",
		tools: [noteItem, listItems],
		sections: [
			section(
				"items",
				() =>
					"What the user will need to come back to (a due date, a reply they wait for, a price or place to watch) goes in note_item with next_at, not only in memory or a table: at next_at the phone wakes you here with it. A timer or alarm only rings; use them when the user asks for one, not to follow something up. Close it with state done once it is handled.",
			),
		],
	});
}
