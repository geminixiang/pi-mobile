import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, type AgentState, configure, type ConversationId, defineTool, type Harness, type Tx } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { Grant } from "./mcp.ts";
import { type Bot, BotIndex } from "./bots.ts";
import { type Groups, legacyOff, type Place, removedTools } from "./toolsets.ts";
import type { Native } from "../native.ts";
import { serially } from "../promise.ts";

const context = BACKGROUND_CONTEXT;

type ModelTools = AgentState["modelTools"];

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

function withoutTools(modelTools: ModelTools, prefix: string, builtin: ReadonlySet<string>): ModelTools {
	const keep = (names: readonly string[] | undefined) => (names ?? []).filter((name) => !name.startsWith(prefix) || builtin.has(name));
	if (modelTools === undefined) return undefined;
	if (Array.isArray(modelTools)) return keep(modelTools);
	return { ...(modelTools.remove ? { remove: modelTools.remove } : {}), ...(modelTools.add ? { add: keep(modelTools.add) } : {}) };
}

const servicesOf = (state: AgentState | undefined): string[] => {
	const extensions = state?.extensions;
	return extensions === undefined || Array.isArray(extensions) ? [] : [...(extensions.add ?? [])];
};

const removedOf = (state: AgentState | undefined): string[] => {
	const tools = state?.tools;
	return tools === undefined || Array.isArray(tools) ? [] : [...tools.remove];
};

type Edit = { off?: (off: readonly string[]) => readonly string[]; services?: (services: readonly string[]) => readonly string[]; also?: (tx: Tx) => Promise<void> };

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((name, index) => name === b[index]);

export class BotToolsets {
	readonly #harness: Harness;
	readonly #owners: ReadonlyMap<string, Groups>;
	readonly #native: Native;
	readonly #place: (id: ConversationId) => Place;
	readonly #write = serially();
	readonly #placed = new Map<ConversationId, Place>();

	constructor(harness: Harness, owners: ReadonlyMap<string, Groups>, native: Native, place: (id: ConversationId) => Place) {
		this.#harness = harness;
		this.#owners = owners;
		this.#native = native;
		this.#place = place;
	}

	async off(bot: Bot): Promise<readonly string[]> {
		return bot.off ?? legacyOff((await this.#harness.snapshot(AgentDoc, bot.id, context))?.extensions);
	}

	async services(id: ConversationId): Promise<string[]> {
		return servicesOf(await this.#harness.snapshot(AgentDoc, id, context));
	}

	apply(ids: readonly ConversationId[]): Promise<void> {
		return this.#write(async () => {
			for (const id of ids.filter((candidate) => this.#placed.get(candidate) !== this.#place(candidate))) {
				await this.#commit(id, {});
			}
		});
	}

	setGroup(id: ConversationId, group: string, enabled: boolean): Promise<void> {
		return this.#write(() => this.#commit(id, { off: (off) => [...off.filter((name) => name !== group), ...(enabled ? [] : [group])] }));
	}

	setService(id: ConversationId, extension: string, enabled: boolean): Promise<void> {
		return this.#write(() => this.#commit(id, { services: (services) => [...services.filter((name) => name !== extension), ...(enabled ? [extension] : [])] }));
	}

	revoke(grant: Grant, ids: readonly ConversationId[]): Promise<void> {
		return this.#write(async () => {
			for (const id of ids) {
				const state = await this.#harness.snapshot(AgentDoc, id, context);
				const modelTools = withoutTools(state?.modelTools, grant.toolPrefix, grant.builtin);
				const changed = JSON.stringify(modelTools) !== JSON.stringify(state?.modelTools);
				await this.#commit(id, {
					services: (services) => services.filter((name) => name !== grant.extension),
					also: async (tx) => {
						if (!changed) return;
						await configure(tx, id, {
							modelTools:
								modelTools === undefined
									? null
									: Array.isArray(modelTools)
										? byName(modelTools)
										: { ...(modelTools.add ? { add: byName(modelTools.add) } : {}), ...(modelTools.remove ? { remove: byName(modelTools.remove) } : {}) },
						});
					},
				});
			}
		});
	}

	async #commit(id: ConversationId, edit: Edit): Promise<void> {
		const place = this.#place(id);
		await this.#harness.commit(async (tx) => {
			await this.#project(tx, id, place, edit);
			await edit.also?.(tx);
		}, context);
		this.#placed.set(id, place);
	}

	async #project(tx: Tx, id: ConversationId, place: Place, edit: Edit): Promise<void> {
		const bot = (await tx.doc(BotIndex)).items.find((candidate) => candidate.id === id);
		if (!bot) return;
		const agent = await tx.doc(AgentDoc, id);
		const stored = bot.off ?? legacyOff(agent.extensions);
		const off = edit.off ? edit.off(stored) : stored;
		if (!bot.off || !same(bot.off, off)) bot.off = [...off];
		const services = edit.services ? edit.services(servicesOf(agent)) : servicesOf(agent);
		const removed = removedTools(this.#owners, off, place, this.#native);
		const extensionsSettled = !Array.isArray(agent.extensions) && (agent.extensions?.remove ?? []).length === 0;
		if (!extensionsSettled || !same(servicesOf(agent), services)) await configure(tx, id, { extensions: services.length > 0 ? { add: services.map((name) => ({ name })) } : null });
		if (!same(removedOf(agent), removed)) await configure(tx, id, { tools: removed.length > 0 ? { remove: byName(removed) } : null });
	}
}
