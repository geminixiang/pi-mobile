import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, type AgentState, defineTool, type Harness } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { Grant } from "./mcp.ts";
import { selectionOf, type Selection, type Toolset, withToolset } from "./toolsets.ts";
import { serially } from "../promise.ts";

const context = BACKGROUND_CONTEXT;

type ModelTools = AgentState["modelTools"];

const named = (names: readonly string[]) => names.map((name) => ({ name }));

const byName = (names: readonly string[]) =>
	names.map((name) =>
		defineTool({
			name,
			description: name,
			parameters: Type.Object({}),
			execute: async () => {
				throw new Error(`${name} names a tool in a bot's settings and does not run`);
			},
		}),
	);

function withoutTools(modelTools: ModelTools, prefix: string): ModelTools {
	const keep = (names: readonly string[] | undefined) => (names ?? []).filter((name) => !name.startsWith(prefix));
	if (modelTools === undefined) return undefined;
	if (Array.isArray(modelTools)) return keep(modelTools);
	return { ...(modelTools.remove ? { remove: modelTools.remove } : {}), ...(modelTools.add ? { add: keep(modelTools.add) } : {}) };
}

export class BotToolsets {
	readonly #harness: Harness;
	readonly #bots: () => Promise<readonly { id: ConversationId }[]>;
	readonly #all: () => Toolset[];
	readonly #write = serially();

	constructor(harness: Harness, bots: () => Promise<readonly { id: ConversationId }[]>, all: () => Toolset[]) {
		this.#harness = harness;
		this.#bots = bots;
		this.#all = all;
	}

	async selection(id: ConversationId): Promise<Selection> {
		return selectionOf(await this.#harness.snapshot(AgentDoc, id, context));
	}

	set(id: ConversationId, toolset: string, enabled: boolean): Promise<void> {
		return this.#write(async () => {
			const target = this.#all().find((candidate) => candidate.id === toolset);
			if (!target) throw new Error(`${toolset} is not available`);
			await this.#configure(id, (selection, modelTools) => ({ selection: withToolset(selection, target, enabled), modelTools }));
		});
	}

	revoke(grant: Grant): Promise<void> {
		return this.#write(async () => {
			for (const bot of await this.#bots()) {
				await this.#configure(bot.id, (selection, modelTools) => ({
					selection: { add: selection.add.filter((name) => name !== grant.extension), remove: selection.remove },
					modelTools: withoutTools(modelTools, grant.toolPrefix),
				}));
			}
		});
	}

	async #configure(
		id: ConversationId,
		change: (selection: Selection, modelTools: ModelTools) => { selection: Selection; modelTools: ModelTools },
	): Promise<void> {
		const conversation = await this.#harness.conversation(id, context);
		if (!conversation) return;
		const state = await this.#harness.snapshot(AgentDoc, id, context);
		const selection = selectionOf(state);
		const { selection: next, modelTools } = change(selection, state?.modelTools);
		const extensionsChanged = JSON.stringify(next) !== JSON.stringify(selection);
		const toolsChanged = JSON.stringify(modelTools) !== JSON.stringify(state?.modelTools);
		if (!extensionsChanged && !toolsChanged) return;
		const { add, remove } = next;
		await conversation.configure(
			{
				...(extensionsChanged ? { extensions: add.length + remove.length > 0 ? { add: named(add), remove: named(remove) } : null } : {}),
				...(toolsChanged
					? {
							modelTools:
								modelTools === undefined
									? null
									: Array.isArray(modelTools)
										? byName(modelTools)
										: { ...(modelTools.add ? { add: byName(modelTools.add) } : {}), ...(modelTools.remove ? { remove: byName(modelTools.remove) } : {}) },
						}
					: {}),
			},
			context,
		);
	}
}
