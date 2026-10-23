import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	type Conversation,
	type ConversationId,
	type ConversationView,
	createRegistry,
	Harness,
	InboxDoc,
	type Storage,
	type SubmissionId,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { type Settings } from "../settings.ts";
import { orLogged, messageOf, settled } from "../promise.ts";
import { Assistant } from "./assistant.ts";
import { deleteAttachments } from "./attachments.ts";
import { loadModels, startModelList } from "./available-models.ts";
import { avatarOf, type Bot, BotIndex, DEFAULT_BOT, MAX_BOTS, MAX_JOB, newFolder } from "./bots.ts";
import { parseCalendarAccess } from "./calendar-access.ts";
import { builtinExtensions } from "./catalog.ts";
import { connectClouds } from "./clouds.ts";
import { type Computer, Computers, MISSING_COMPUTER, type Placement } from "./computers.ts";
import { PhoneEnv, removePhoneFolder } from "./files/phone-env.ts";
import { extensionName, McpHub } from "./mcp.ts";
import { BotMemoryDoc, type Memory, MEMORY_LIMIT, MemoryDoc, type MemoryScope } from "./memory.ts";
import { isThinkingLevel, type ModelInfo } from "./models.ts";
import { hostOf } from "./parse.ts";
import type { Host } from "./sandbox/host.ts";
import type { Sandbox } from "./sandbox/sandbox.ts";
import { Workspace } from "./sandbox/workspace.ts";
import { isEnabled, type Selection, selectionOf, type Toolset, TOOLSETS, type ToolsetId, type ToolsetState, withToolset } from "./toolsets.ts";
import { type TriggerHost, TriggerRuns } from "./triggers.ts";

const context = BACKGROUND_CONTEXT;

export type UserContent = (TextContent | ImageContent)[];

export type BusyMode = "steer" | "followUp";

export interface ConversationController {
	readonly id: ConversationId;
	subscribe(listener: (view: ConversationView) => void): () => void;
	send(content: UserContent, whenBusy?: BusyMode): Promise<void>;
	withdraw(submissionId: SubmissionId): Promise<void>;
	stop(): Promise<string[]>;
	compact(): Promise<boolean>;
	reset(): Promise<void>;
	setModel(provider: string, modelId: string): Promise<void>;
	setThinking(level: string): Promise<void>;
	dispose(): void;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is TextContent => part?.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function labelOf(extension: string, mcp: McpHub): string {
	const server = mcp.servers.find((candidate) => extensionName(candidate) === extension);
	if (server) return `${server.name} (a service the user connected)`;
	return TOOLSETS.find((toolset) => toolset.extensions.includes(extension))?.label ?? extension;
}

export type ToolCost = Record<string, { offered: number; deferred: number; tools: string[] }>;

export class AgentRuntime {
	readonly models: ModelInfo[];
	readonly #harness: Harness;
	readonly #settings: Settings;
	readonly #computers: Computers;
	readonly #choices: Map<string, string | undefined>;
	#botListeners = new Set<(bots: Bot[]) => void>();
	readonly #folders: Map<string, string>;
	#memoryListeners = new Set<() => void>();
	readonly #installed: () => ReadonlySet<string>;
	readonly mcp: McpHub;
	readonly triggers: TriggerRuns;
	#toolsetWrites: Promise<void> = Promise.resolve();

	private constructor(
		harness: Harness,
		settings: Settings,
		models: ModelInfo[],
		computers: Computers,
		folders: Map<string, string>,
		choices: Map<string, string | undefined>,
		installed: () => ReadonlySet<string>,
		mcp: McpHub,
	) {
		this.#installed = installed;
		this.mcp = mcp;
		this.#harness = harness;
		this.#settings = settings;
		this.models = models;
		this.#computers = computers;
		this.#folders = folders;
		this.#choices = choices;
		this.triggers = new TriggerRuns(
			harness,
			async () => (await this.bots()).map((bot) => ({ id: bot.id, avatar: avatarOf(bot) })),
			(id, at) => this.#touchBot(id, at),
		);
	}

	#touchBot(id: ConversationId, at: number): Promise<void> {
		return this.#editBots((items) => {
			const bot = items.find((candidate) => candidate.id === id);
			if (bot) bot.updatedAt = at;
		});
	}

	get hasSandbox(): boolean {
		return this.#computers.any;
	}

	computerOf(id: ConversationId | string): Placement {
		return this.#computers.resolve(this.#choices.get(String(id)));
	}

	computers(): Computer[] {
		return this.#computers.list();
	}

	hostOf(key: string): Host | undefined {
		return this.#computers.host(key);
	}

	sandboxOf(id: ConversationId | string): Sandbox | undefined {
		return this.#computers.sandboxAt(this.computerOf(id));
	}

	async setComputer(id: ConversationId, key: string): Promise<void> {
		await this.#editBots((items) => {
			const bot = items.find((candidate) => candidate.id === id);
			if (bot) bot.computer = key;
		});
	}

	folderOf(id: ConversationId): { path: string; where: string } | undefined {
		const folder = this.#folders.get(String(id));
		const placement = this.computerOf(id);
		const sandbox = this.#computers.sandboxAt(placement);
		if (placement.kind === "missing" || !sandbox || !folder) return undefined;
		const name = placement.computer.name;
		return { path: sandbox.root(folder), where: sandbox.direct ? name : `${name} 的容器` };
	}

	static async open(
		storage: Storage,
		settings: Settings,
		options: {
			onReport?: (message: string) => void;
			notify?: (title: string, text: string, conversationId: ConversationId, avatar: string | undefined) => Promise<boolean>;
			openUrl?: (url: string) => Promise<void>;
			modelIds?: Promise<Record<string, string[]>>;
		} = {},
	): Promise<AgentRuntime> {
		const { models, infos, webSearch } = await loadModels(settings, options.modelIds ?? startModelList(settings), options.onReport);
		const registry = createRegistry();
		let runtimeRef: AgentRuntime | undefined;
		const triggerHost: TriggerHost = {
			changed: () => void runtimeRef?.triggers.sync(),
			notify: async (title, text, conversationId) => {
				const bot = (await runtimeRef?.bots())?.find((candidate) => candidate.id === conversationId);
				return (await options.notify?.(title, text, conversationId, bot && avatarOf(bot))) ?? false;
			},
		};
		const folders = new Map<string, string>();
		const clouds = connectClouds(settings);
		const choices = new Map<string, string | undefined>();
		const computers = new Computers(settings, clouds.minted);
		const placementOf = (id: string) => computers.resolve(choices.get(id));
		const sandboxOf = (id: string) => computers.sandboxAt(placementOf(id));
		const mcp: McpHub = new McpHub({
			install: (extension) => registry.install(extension),
			uninstall: (name) => registry.uninstall({ name }),
			revoke: (extension) => runtimeRef?.revokeEverywhere(extension) ?? Promise.resolve(),
			openUrl: (url) => options.openUrl?.(url) ?? Promise.reject(new Error("cannot open the browser here")),
		});
		for (const extension of builtinExtensions({
			assistant: Assistant,
			calendarAccess: parseCalendarAccess(settings.calendarAccess),
			...(settings.githubToken ? { githubToken: async () => settings.githubToken || undefined } : {}),
			clouds: clouds.services,
			web: webSearch,
			triggers: triggerHost,
			memory: { changed: () => void runtimeRef?.publishMemory() },
			sandbox: { sandboxOf, folderOf: (id: string) => folders.get(id), onPhone: (id: string) => placementOf(id).kind === "ready" && !sandboxOf(id) },
			hostOf: (id: string) => {
				const placement = placementOf(id);
				return placement.kind === "ready" ? computers.host(placement.computer.key) : undefined;
			},
			labelOf: (name, id) => (name === "computer" && !sandboxOf(id) ? undefined : labelOf(name, mcp)),
		})) {
			registry.install(extension);
		}
		const harness = await Harness.open(
			storage,
			{
				models,
				registry,
				settings: {
					get extensions() {
						return registry
							.snapshot()
							.installed()
							.filter((extension) => !extension.name.startsWith("mcp-"));
					},
				},
				onReport: (error) => options.onReport?.(messageOf(error)),
				env: ({ conversationId }) => {
					const folder = folders.get(String(conversationId));
					if (!folder) return undefined;
					if (placementOf(String(conversationId)).kind === "missing") throw new Error(MISSING_COMPUTER);
					return sandboxOf(String(conversationId))?.env(folder) ?? new PhoneEnv(folder);
				},
			},
			context,
		);
		const runtime = new AgentRuntime(
			harness,
			settings,
			infos,
			computers,
			folders,
			choices,
			() => new Set(registry.snapshot().installed().map((extension) => extension.name)),
			mcp,
		);
		mcp.refreshAll();
		runtimeRef = runtime;
		if ((await runtime.bots()).length === 0) await runtime.createBot(DEFAULT_BOT);
		else await runtime.#publishBots();
		await runtime.triggers.sync().catch((error: unknown) => options.onReport?.(`排程同步失敗：${messageOf(error)}`));
		harness.resume();
		return runtime;
	}

	#defaultAgent() {
		const { defaultProvider: provider, defaultModelId: modelId } = this.#settings;
		const known = this.models.some((model) => model.provider === provider && model.id === modelId);
		const first = this.models[0];
		const model = known || !first ? { provider, modelId } : { provider: first.provider, modelId: first.id };
		const thinking = this.#settings.defaultThinking;
		return { model, thinkingLevel: isThinkingLevel(thinking) ? thinking : "low" };
	}

	async bots(): Promise<Bot[]> {
		const index = await this.#harness.snapshot(BotIndex, context);
		return [...(index?.items ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
	}

	subscribeBots(listener: (bots: Bot[]) => void): () => void {
		this.#botListeners.add(listener);
		void this.bots().then(listener);
		return () => this.#botListeners.delete(listener);
	}

	async #publishBots(): Promise<void> {
		const bots = await this.bots();
		this.#folders.clear();
		this.#choices.clear();
		for (const bot of bots) {
			this.#folders.set(String(bot.id), bot.folder);
			this.#choices.set(String(bot.id), bot.computer);
		}
		for (const listener of this.#botListeners) listener(bots);
	}

	async #editBots(edit: (items: Bot[]) => void): Promise<void> {
		await this.#harness.commit(async (tx) => edit((await tx.doc(BotIndex)).items), context);
		await this.#publishBots();
	}

	async createBot({ name, job, avatar }: { name: string; job: string; avatar: string }): Promise<ConversationId> {
		const trimmed = name.trim();
		if (!trimmed) throw new Error("Bot 需要名字");
		if (job.length > MAX_JOB) throw new Error(`工作說明最多 ${MAX_JOB} 字`);
		const existing = await this.bots();
		if (existing.length >= MAX_BOTS) throw new Error(`最多 ${MAX_BOTS} 個 Bot`);
		const folder = newFolder();
		const conversation = await this.#harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: this.#defaultAgent(),
				init: async (tx, id) => {
					const now = Date.now();
					(await tx.doc(BotIndex)).items.push({ id, name: trimmed, job: job.trim(), folder, avatar, createdAt: now, updatedAt: now });
				},
			},
			context,
		);
		await this.#publishBots();
		return conversation.id;
	}

	async updateBot(id: ConversationId, change: { name: string; job: string; avatar: string }): Promise<void> {
		const name = change.name.trim();
		if (!name) throw new Error("Bot 需要名字");
		if (change.job.length > MAX_JOB) throw new Error(`工作說明最多 ${MAX_JOB} 字`);
		await this.#editBots((items) => {
			const bot = items.find((candidate) => candidate.id === id);
			if (!bot) return;
			bot.name = name;
			bot.job = change.job.trim();
			bot.avatar = change.avatar;
		});
		await orLogged(this.triggers.sync(), "triggers.sync_failed", undefined);
	}

	async removeBot(id: ConversationId): Promise<void> {
		const bots = await this.bots();
		const bot = bots.find((candidate) => candidate.id === id);
		if (!bot) return;
		if (bots.length === 1) throw new Error("至少要留一個 Bot");
		await (await this.#harness.conversation(id, context))?.abort(context, { background: true });
		await this.triggers.removeBot(id);
		await this.#harness.commit(async (tx) => {
			const items = (await tx.doc(BotIndex)).items;
			const at = items.findIndex((candidate) => candidate.id === id);
			if (at >= 0) items.splice(at, 1);
			await tx.retireDoc(BotMemoryDoc, id);
		}, context);
		await this.#publishBots();
		await Promise.all(
			this.#computers
				.list()
				.map((computer) => this.#computers.sandbox(computer.key))
				.filter((sandbox) => sandbox && !sandbox.direct)
				.map((sandbox) => sandbox && orLogged(sandbox.remove(bot.folder), "bot.remove_container_folder_failed", undefined, { bot: bot.folder })),
		);
		await orLogged(removePhoneFolder(bot.folder), "bot.remove_phone_folder_failed", undefined, { bot: bot.folder });
		await orLogged(deleteAttachments({ conversationId: String(id) }), "bot.remove_attachments_failed", undefined, { bot: String(id) });
	}

	subscribeActivity(listener: (busy: ReadonlySet<ConversationId>) => void): () => void {
		let disposed = false;
		let dispose = () => {
			disposed = true;
		};
		void this.#harness.taskGraph(context).then((state) => {
			if (disposed) {
				state.dispose();
				return;
			}
			const emit = (graph: { tasks: Readonly<Record<string, { conversationId: ConversationId; background: boolean }>> }) =>
				listener(new Set(Object.values(graph.tasks).flatMap((task) => (task.background ? [] : [task.conversationId]))));
			emit(state.value);
			const unsubscribe = state.subscribe((graph) => emit(graph));
			dispose = () => {
				unsubscribe();
				state.dispose();
			};
		});
		return () => dispose();
	}

	async workspace(id: ConversationId): Promise<Workspace | undefined> {
		const folder = this.#folders.get(String(id));
		const sandbox = this.sandboxOf(id);
		if (!sandbox || !folder || !(await sandbox.exists(folder))) return undefined;
		return new Workspace(await sandbox.env(folder), sandbox.root(folder));
	}

	phoneFolder(id: ConversationId): ExecutionEnv | undefined {
		const folder = this.#folders.get(String(id));
		return folder ? new PhoneEnv(folder) : undefined;
	}

	async resetSandbox(id: ConversationId): Promise<void> {
		const folder = this.#folders.get(String(id));
		const sandbox = this.sandboxOf(id);
		if (!sandbox || !folder) throw new Error("No sandbox configured");
		await sandbox.remove(folder);
	}

	async openConversation(id: ConversationId): Promise<ConversationController> {
		const conversation: Conversation | undefined = await this.#harness.conversation(id, context);
		if (!conversation) throw new Error(`Unknown conversation ${id}`);
		const view = await conversation.viewState(context);
		const inFlight = new Set<Promise<unknown>>();
		return {
			id,
			subscribe: (listener) => {
				listener(view.value);
				return view.subscribe(listener);
			},
			send: (content, whenBusy = "steer") => {
				const submitted = (async () => {
					if (content.length > 0) await this.#touchBot(id, Date.now());
					await conversation.submit({ type: "input", content, whenBusy }, context);
				})();
				inFlight.add(submitted);
				return submitted.finally(() => inFlight.delete(submitted));
			},
			withdraw: async (submissionId) => {
				await this.#harness.abortSubmission(submissionId, context, id);
			},
			stop: async () => {
				await Promise.allSettled(inFlight);
				const inbox = await this.#harness.snapshot(InboxDoc, id, context);
				const returned: string[] = [];
				for (const item of inbox?.items ?? []) {
					if (item.mode === "write") continue;
					if ((await this.#harness.abortSubmission(item.id, context, id)) === "aborted") returned.push(contentText(item.content));
				}
				await conversation.abort(context);
				return returned.filter(Boolean);
			},
			compact: async () => {
				const before = view.value.entries.filter((entry) => entry.kind === "pi.compaction").length;
				await this.#harness.waitForTask(await conversation.compact(undefined, context), context);
				return view.value.entries.filter((entry) => entry.kind === "pi.compaction").length > before;
			},
			reset: () => conversation.reset(undefined, context),
			setModel: (provider, modelId) => conversation.configure({ model: { provider, modelId } }, context),
			setThinking: async (level) => {
				if (!isThinkingLevel(level)) throw new Error(`unknown thinking level ${level}`);
				await conversation.configure({ thinkingLevel: level }, context);
			},
			dispose: () => view.dispose(),
		};
	}

	async toolCost(id: ConversationId): Promise<ToolCost> {
		const conversation = await this.#harness.conversation(id, context);
		if (!conversation) return {};
		const agent = await conversation.agent(context);
		const owner = new Map<string, string>();
		for (const extension of agent.extensions) for (const tool of extension.tools ?? []) owner.set(tool.name, extension.name);
		const cost: ToolCost = {};
		const add = (tool: { name: string; description: string; parameters: unknown }, kind: "offered" | "deferred") => {
			const name = owner.get(tool.name) ?? "?";
			const entry = (cost[name] ??= { offered: 0, deferred: 0, tools: [] });
			entry[kind] += JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }).length;
			entry.tools.push(tool.name);
		};
		for (const tool of agent.tools) add(tool, "offered");
		for (const tool of agent.deferred) add(tool, "deferred");
		return cost;
	}

	#allToolsets(): Toolset[] {
		return [
			...TOOLSETS,
			...this.mcp.servers.map((server) => ({
				kind: "service" as const,
				id: extensionName(server),
				label: server.name,
				hint: hostOf(server.url),
				extensions: [extensionName(server)],
			})),
		];
	}

	async toolsets(id: ConversationId): Promise<ToolsetState[]> {
		const selection = selectionOf(await this.#harness.snapshot(AgentDoc, id, context));
		const installed = this.#installed();
		const notHere = new Set(this.computerOf(id).kind === "missing" ? ["files", "sandbox", "computer"] : this.sandboxOf(id) ? ["files"] : ["sandbox", "computer"]);
		return this.#allToolsets().map((toolset) => ({
			...toolset,
			available: !notHere.has(toolset.id) && toolset.extensions.every((name) => installed.has(name)),
			enabled: isEnabled(selection, toolset),
		}));
	}

	setToolset(id: ConversationId, toolset: ToolsetId | string, enabled: boolean): Promise<void> {
		return this.#writeToolsets(async () => {
			const target = this.#allToolsets().find((candidate) => candidate.id === toolset);
			if (target) await this.#select(id, (selection) => withToolset(selection, target, enabled));
		});
	}

	revokeEverywhere(extension: string): Promise<void> {
		return this.#writeToolsets(async () => {
			for (const bot of await this.bots()) {
				await this.#select(bot.id, (selection) => ({ add: selection.add.filter((name) => name !== extension), remove: selection.remove }));
			}
		});
	}

	#writeToolsets(write: () => Promise<void>): Promise<void> {
		const change = this.#toolsetWrites.then(write);
		this.#toolsetWrites = settled(change);
		return change;
	}

	async #select(id: ConversationId, change: (selection: Selection) => Selection): Promise<void> {
		const conversation = await this.#harness.conversation(id, context);
		if (!conversation) return;
		const before = selectionOf(await this.#harness.snapshot(AgentDoc, id, context));
		const selection = change(before);
		if (JSON.stringify(selection) === JSON.stringify(before)) return;
		const named = (names: string[]) => names.map((name) => ({ name }));
		await conversation.configure(
			{ extensions: selection.add.length + selection.remove.length > 0 ? { add: named(selection.add), remove: named(selection.remove) } : null },
			context,
		);
	}

	async memory(scope: MemoryScope): Promise<Memory> {
		const memory = scope.kind === "global" ? await this.#harness.snapshot(MemoryDoc, context) : await this.#harness.snapshot(BotMemoryDoc, scope.id, context);
		return { ...(memory ?? { text: "", updatedAt: 0, updatedBy: "" }) };
	}

	subscribeMemory(scope: MemoryScope, listener: (memory: Memory) => void): () => void {
		const reload = () => void this.memory(scope).then(listener);
		this.#memoryListeners.add(reload);
		reload();
		return () => this.#memoryListeners.delete(reload);
	}

	publishMemory(): void {
		for (const listener of this.#memoryListeners) listener();
	}

	async saveMemory(scope: MemoryScope, text: string): Promise<void> {
		const trimmed = text.trim();
		if (trimmed.length > MEMORY_LIMIT) throw new Error(`記憶最多 ${MEMORY_LIMIT} 字，現在是 ${trimmed.length} 字`);
		await this.#harness.commit(async (tx) => {
			const memory = scope.kind === "global" ? await tx.doc(MemoryDoc) : await tx.doc(BotMemoryDoc, scope.id);
			memory.text = trimmed;
			memory.updatedAt = Date.now();
			memory.updatedBy = "user";
		}, context);
		this.publishMemory();
	}

	inspect(): Promise<unknown> {
		return this.#harness.inspect(context);
	}

	async close(): Promise<void> {
		await this.mcp.close();
		await this.#harness.close(context);
		this.#computers.close();
	}
}

export type { ConversationId, SubmissionId };
