import { createJudge, type Judge } from "./judge.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { contentText, type ImageContent, type TextContent } from "@earendil-works/pi-ai";
import {
	type Conversation,
	type ConversationId,
	type ConversationView,
	createRegistry,
	Harness,
	InboxDoc,
	type SessionEnd,
	type Storage,
	type SubmissionId,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { changedKeys, type Settings } from "../settings.ts";
import { orLogged, messageOf } from "../promise.ts";
import { createAssistant } from "./assistant.ts";
import { pairedHosts } from "./sandbox/host.ts";
import { agentState } from "../computer-agents/tool.ts";
import { deleteAttachments } from "./attachments.ts";
import { BotToolsets } from "./bot-toolsets.ts";
import { avatarOf, type Bot, botFields, BotIndex, DEFAULT_BOT, MAX_BOTS } from "./bots.ts";
import { uuidv7 } from "@earendil-works/pi-ai/utils/uuid";
import { builtinExtensions } from "./catalog.ts";
import { connectClouds } from "./clouds.ts";
import { extensionName, isMcpExtension, McpHub } from "./mcp.ts";
import { BotMemoryDoc, emptyMemory, type Memory, MEMORY_LIMIT, MemoryDoc, type MemoryScope } from "./memory.ts";
import { isThinkingLevel, type ModelInfo } from "./models.ts";
import type { LoadedModels } from "./available-models.ts";
import { hostOf } from "./parse.ts";
import type { Platform } from "./platform.ts";
import { Workspace } from "./sandbox/workspace.ts";
import { isEnabled, type Toolset, TOOLSETS, type ToolsetState, usable } from "./toolsets.ts";
import { TriggerRuns } from "../triggers/runs.ts";
import type { Notified, TriggerHost } from "../triggers/tool.ts";
import { type Placed, type Workplace, Workplaces } from "./workplaces.ts";

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

function labelOf(extension: string, mcp: McpHub): string {
	const server = mcp.servers.find((candidate) => extensionName(candidate) === extension);
	if (server) return `${server.name} (a service the user connected)`;
	return TOOLSETS.find((toolset) => toolset.extensions.includes(extension))?.label ?? extension;
}

type ToolCost = Record<string, { offered: number; deferred: number; tools: string[] }>;

const NOT_HERE: Record<Workplace["kind"], ReadonlySet<string>> = {
	phone: new Set(["sandbox", "computer", "computer_agents"]),
	computer: new Set(["files"]),
	missing: new Set(["files", "sandbox", "computer", "computer_agents"]),
};

const IN_PLACE: ReadonlySet<keyof Settings> = new Set(["hosts", "hostKeys", "computer", "defaultProvider", "defaultModelId", "defaultThinking", "compactAt", "searchEngine"]);

type Loaded = Pick<LoadedModels, "models" | "infos">;

type Applied = "in_place" | "needs_restart";

export class AgentRuntime {
	readonly #loaded: Loaded;
	readonly #harness: Harness;
	#settings: Settings;
	readonly workplaces: Workplaces;
	readonly #placed: Map<string, Placed>;
	#botListeners = new Set<(bots: Bot[]) => void>();
	#memoryListeners = new Set<() => void>();
	readonly #installed: () => ReadonlySet<string>;
	readonly #unsupported: ReadonlySet<string>;
	readonly mcp: McpHub;
	readonly triggers: TriggerRuns;
	readonly #botToolsets: BotToolsets;
	readonly #platform: Platform;

	private constructor(
		harness: Harness,
		settings: Settings,
		platform: Platform,
		loaded: Loaded,
		workplaces: Workplaces,
		placed: Map<string, Placed>,
		installed: () => ReadonlySet<string>,
		unsupported: ReadonlySet<string>,
		mcp: McpHub,
		judge: Judge,
	) {
		this.#installed = installed;
		this.#unsupported = unsupported;
		this.#platform = platform;
		this.mcp = mcp;
		this.#harness = harness;
		this.#settings = settings;
		this.#loaded = loaded;
		this.workplaces = workplaces;
		this.#placed = placed;
		this.triggers = new TriggerRuns(
			harness,
			async () => (await this.bots()).map((bot) => ({ id: bot.id, name: bot.name, avatar: avatarOf(bot) })),
			(id, at) => this.#touchBot(id, at),
			judge,
			async (id, agent) => {
				const place = this.workplaces.at(String(id));
				return place?.kind === "computer" ? agentState(place.host, agent) : "unreachable";
			},
		);
		this.#botToolsets = new BotToolsets(harness, () => this.bots(), () => this.#allToolsets());
	}

	#touchBot(id: ConversationId, at: number): Promise<void> {
		return this.#editBot(id, (bot) => {
			bot.updatedAt = at;
		});
	}

	get settings(): Settings {
		return this.#settings;
	}

	get models(): ModelInfo[] {
		return this.#loaded.infos;
	}

	async apply(next: Settings): Promise<Applied> {
		const changed = changedKeys(this.#settings, next);
		if (changed.some((key) => !IN_PLACE.has(key))) return "needs_restart";
		if (changed.includes("compactAt")) {
			const { models, infos } = await this.#platform.models(next);
			this.#loaded.models = models;
			this.#loaded.infos = infos;
		}
		this.#settings = next;
		if (changed.some((key) => key === "hosts" || key === "hostKeys" || key === "computer")) {
			this.workplaces.apply(next);
			await this.#publishBots();
		}
		return "in_place";
	}

	setComputer(id: ConversationId, key: string): Promise<void> {
		return this.#editBot(id, (bot) => {
			bot.computer = key;
		});
	}

	static async open(
		storage: Storage,
		settings: Settings,
		platform: Platform,
		options: {
			onReport?: (message: string) => void;
			notify?: (title: string, text: string, conversationId: ConversationId, bot: { name: string; avatar: string } | undefined) => Promise<Notified>;
			openUrl?: (url: string) => Promise<void>;
		} = {},
	): Promise<AgentRuntime> {
		const { models, infos, webSearch } = await platform.models(settings, options.onReport);
		const loaded: Loaded = { models, infos };
		const registry = createRegistry();
		let runtimeRef: AgentRuntime | undefined;
		const triggerHost: TriggerHost = {
			changed: () => void runtimeRef?.triggers.sync(),
			notify: async (title, text, conversationId) => {
				const bot = (await runtimeRef?.bots())?.find((candidate) => candidate.id === conversationId);
				return (await options.notify?.(title, text, conversationId, bot && { name: bot.name, avatar: avatarOf(bot) })) ?? "off";
			},
		};
		const placed = new Map<string, Placed>();
		const clouds = connectClouds(settings, platform.rotated);
		const workplaces = new Workplaces(settings, clouds.minted, platform.phone, (id) => placed.get(id));
		const at = (id: string) => workplaces.at(id);
		const mcp: McpHub = new McpHub(platform, {
			install: (extension) => registry.install(extension),
			uninstall: (name) => registry.uninstall({ name }),
			revoke: (grant) => (runtimeRef ? runtimeRef.#botToolsets.revoke(grant) : Promise.resolve()),
			openUrl: (url) => options.openUrl?.(url) ?? Promise.reject(new Error("cannot open the browser here")),
			hostKey: (address) => pairedHosts(runtimeRef?.settings ?? settings).find((host) => host.address === address)?.key ?? "",
		});
		const catalog = builtinExtensions({
			native: platform.native,
			assistant: createAssistant(platform.inApp),
			calendarAccess: settings.calendarAccess,
			...(settings.githubToken ? { githubToken: settings.githubToken } : {}),
			clouds: clouds.services,
			web: webSearch,
			triggers: triggerHost,
			memory: { changed: () => void runtimeRef?.publishMemory() },
			workplace: at,
			labelOf: (name, id) => ((name === "computer" || name === "computer_agents") && at(id)?.kind !== "computer" ? undefined : labelOf(name, mcp)),
		});
		for (const extension of catalog.extensions) registry.install(extension);
		const harness = await Harness.open(
			storage,
			{
				models: () => loaded.models,
				registry,
				settings: {
					get extensions() {
						return registry
							.snapshot()
							.installed()
							.filter((extension) => !isMcpExtension(extension.name));
					},
				},
				onReport: (error) => options.onReport?.(messageOf(error)),
				env: ({ conversationId }) => {
					const place = at(String(conversationId));
					return place?.kind === "missing" ? undefined : place?.env();
				},
			},
			context,
		);
		const runtime = new AgentRuntime(
			harness,
			settings,
			platform,
			loaded,
			workplaces,
			placed,
			() => new Set(registry.snapshot().installed().map((extension) => extension.name)),
			catalog.unsupported,
			mcp,
			createJudge(models),
		);
		mcp.refreshAll();
		runtimeRef = runtime;
		if ((await runtime.bots()).length === 0) await runtime.createBot(DEFAULT_BOT);
		else await runtime.#publishBots();
		await runtime.triggers.sync().catch((error: unknown) => options.onReport?.(`自動化同步失敗：${messageOf(error)}`));
		harness.resume();
		for (const bot of await runtime.#allBots()) {
			if (bot.removing) void orLogged(runtime.#finishRemoval(bot), "bot.finish_removal_failed", undefined, { bot: String(bot.id) });
		}
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
		return (await this.#allBots()).filter((bot) => !bot.removing).sort((a, b) => b.updatedAt - a.updatedAt);
	}

	async #allBots(): Promise<Bot[]> {
		return [...((await this.#harness.snapshot(BotIndex, context))?.items ?? [])];
	}

	subscribeBots(listener: (bots: Bot[]) => void): () => void {
		this.#botListeners.add(listener);
		void this.bots().then(listener);
		return () => this.#botListeners.delete(listener);
	}

	async #publishBots(): Promise<void> {
		const bots = await this.bots();
		this.#placed.clear();
		for (const bot of bots) this.#placed.set(String(bot.id), { folder: bot.folder, ...(bot.computer ? { computer: bot.computer } : {}) });
		for (const listener of this.#botListeners) listener(bots);
	}

	async #editBots(edit: (items: Bot[]) => void): Promise<void> {
		await this.#harness.commit(async (tx) => edit((await tx.doc(BotIndex)).items), context);
		await this.#publishBots();
	}

	#editBot(id: ConversationId, edit: (bot: Bot) => void): Promise<void> {
		return this.#editBots((items) => {
			const bot = items.find((candidate) => candidate.id === id);
			if (bot) edit(bot);
		});
	}

	async createBot({ avatar, ...fields }: { name: string; job: string; avatar: string }): Promise<ConversationId> {
		const { name, job } = botFields(fields);
		const existing = await this.bots();
		if (existing.length >= MAX_BOTS) throw new Error(`最多 ${MAX_BOTS} 個 Bot`);
		const folder = uuidv7();
		const conversation = await this.#harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: this.#defaultAgent(),
				init: async (tx, id) => {
					const now = Date.now();
					(await tx.doc(BotIndex)).items.push({ id, name, job, folder, avatar, createdAt: now, updatedAt: now });
				},
			},
			context,
		);
		await this.#publishBots();
		return conversation.id;
	}

	async updateBot(id: ConversationId, change: { name: string; job: string; avatar: string }): Promise<void> {
		const { name, job } = botFields(change);
		await this.#editBot(id, (bot) => {
			bot.name = name;
			bot.job = job;
			bot.avatar = change.avatar;
		});
		await orLogged(this.triggers.sync(), "triggers.sync_failed", undefined);
	}

	async removeBot(id: ConversationId): Promise<void> {
		const bots = await this.bots();
		const bot = bots.find((candidate) => candidate.id === id);
		if (!bot) return;
		if (bots.length === 1) throw new Error("至少要留一個 Bot");
		await this.#editBot(id, (item) => {
			item.removing = { at: Date.now() };
		});
		await this.triggers.removeBot(id);
		await this.#finishRemoval(bot);
	}

	async #finishRemoval(bot: Bot): Promise<void> {
		await (await this.#harness.conversation(bot.id, context))?.abort(context, { background: true });
		const left = await Promise.all(
			this.workplaces.containers().map(({ key, sandbox }) =>
				orLogged(
					sandbox.remove(bot.folder).then(() => undefined),
					"bot.remove_container_folder_failed",
					key,
					{ bot: bot.folder, computer: key },
				),
			),
		);
		const phone = this.#platform.phone;
		if (phone) await orLogged(phone.removeFolder(bot.folder), "bot.remove_phone_folder_failed", undefined, { bot: bot.folder });
		const browser = this.#platform.browser;
		if (browser) await orLogged(browser.forget(String(bot.id)), "bot.remove_browser_failed", undefined, { bot: String(bot.id) });
		await orLogged(deleteAttachments({ conversationId: String(bot.id) }), "bot.remove_attachments_failed", undefined, { bot: String(bot.id) });
		if (left.some((key) => key !== undefined)) return;
		await this.#harness.commit(async (tx) => {
			const items = (await tx.doc(BotIndex)).items;
			const at = items.findIndex((candidate) => candidate.id === bot.id);
			if (at >= 0) items.splice(at, 1);
			await tx.retireDoc(BotMemoryDoc, bot.id);
		}, context);
		await this.#publishBots();
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
			const unsubscribe = state.subscribe(emit);
			dispose = () => {
				unsubscribe();
				state.dispose();
			};
		});
		return () => dispose();
	}

	async workspace(id: ConversationId): Promise<Workspace | undefined> {
		const place = this.workplaces.at(String(id));
		if (place?.kind === "phone") return new Workspace(place.env(), "/", { git: false });
		if (place?.kind !== "computer" || !(await place.sandbox.exists(place.folder))) return undefined;
		return new Workspace(await place.env(), place.root, { git: true });
	}

	phoneFolder(id: ConversationId): ExecutionEnv | undefined {
		const folder = this.#placed.get(String(id))?.folder;
		return folder ? this.#platform.phone?.folder(folder, this.workplaces.network) : undefined;
	}

	async resetSandbox(id: ConversationId): Promise<void> {
		const place = this.workplaces.at(String(id));
		if (place?.kind !== "computer") throw new Error("No sandbox configured");
		await place.sandbox.remove(place.folder);
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
					const bot = (await this.#allBots()).find((candidate) => candidate.id === id);
					if (!bot || bot.removing) throw new Error("這個 Bot 已經刪除");
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
		const selection = await this.#botToolsets.selection(id);
		const installed = this.#installed();
		const notHere = NOT_HERE[this.workplaces.at(String(id))?.kind ?? "missing"];
		const here = this.#allToolsets().filter(
			(toolset) => usable(toolset, this.#platform.native) && !toolset.extensions.every((name) => this.#unsupported.has(name)),
		);
		return here.map((toolset) => ({
			...toolset,
			available: !notHere.has(toolset.id) && toolset.extensions.every((name) => installed.has(name)),
			enabled: isEnabled(selection, toolset),
		}));
	}

	setToolset(id: ConversationId, toolset: string, enabled: boolean): Promise<void> {
		return this.#botToolsets.set(id, toolset, enabled);
	}

	async memory(scope: MemoryScope): Promise<Memory> {
		const memory = scope.kind === "global" ? await this.#harness.snapshot(MemoryDoc, context) : await this.#harness.snapshot(BotMemoryDoc, scope.id, context);
		return { ...(memory ?? emptyMemory()) };
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

	get closed(): Promise<SessionEnd> {
		return this.#harness.closed;
	}

	async close(): Promise<void> {
		try {
			await this.#harness.close(context);
		} finally {
			await this.mcp.close();
			this.workplaces.close();
		}
	}
}

export type { ConversationId, SubmissionId };
