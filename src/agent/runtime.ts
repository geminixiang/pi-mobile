import { Type } from "typebox";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type ImageContent, type TextContent } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	type Conversation,
	type ConversationId,
	type ConversationView,
	createRegistry,
	defineExtension,
	Harness,
	InboxDoc,
	type SubmissionId,
	section,
	type Storage,
} from "@earendil-works/pi-durable";
import { builtinExtensions } from "./catalog.ts";
import { type Computer, Computers } from "./computers.ts";
import type { Host } from "./sandbox/host.ts";
import { isEnabled, selectionOf, type Toolset, TOOLSETS, type ToolsetId, type ToolsetState, withToolset } from "./toolsets.ts";
import { extensionName, McpHub } from "./mcp.ts";
import { avatarOf, type Bot, BotIndex, DEFAULT_BOT, MAX_BOTS, MAX_JOB, newFolder } from "./bots.ts";
import { type Settings, saveAzureCredential, saveCloudflareCredential, saveProviderOAuth, usableProviders } from "../settings.ts";
import { log } from "../log.ts";
import { customProvider, describe, fetchModelIds, inCatalog, isThinkingLevel, type ModelInfo, withCompaction } from "./models.ts";
import { builtinInfo, type ProviderConfig, providerName, parseProviders } from "./providers.ts";
import { gatewayCatalog, memoryCredentials } from "./credentials.ts";
import { chatgptModelsCached, parseOAuthCredential, withOnlyModels } from "./chatgpt.ts";
import { parseCalendarAccess } from "./calendar-access.ts";
import { AzureTokens, checkAzureCredential } from "./azure.ts";
import { checkCloudflareCredential, CloudflareTokens } from "./cloudflare.ts";
import { checkGcloudCredential, GcloudTokens } from "./gcloud.ts";
import type { MintedService } from "./sandbox/container.ts";
import type { Sandbox } from "./sandbox/sandbox.ts";
import { Workspace } from "./sandbox/workspace.ts";
import { azureService, type CloudService, cloudflareService, googleService } from "./tools/cloud.ts";
import { deleteAttachments } from "./attachments.ts";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { PhoneEnv, removePhoneFolder } from "./files/phone-env.ts";
import { BotMemoryDoc, type Memory, MEMORY_LIMIT, MemoryDoc, type MemoryScope } from "./memory.ts";
import {
	type Delivery,
	LIMITS,
	nativeTriggers,
	type Trigger,
	TRIGGER_ENTRY,
	TriggerDoc,
	type TriggerHost,
	Triggers,
} from "./triggers.ts";
import { messageOf, orLogged, settled } from "../promise.ts";
import { readStored, hostOf } from "./parse.ts";

const context = BACKGROUND_CONTEXT;

function today(): string {
	const now = new Date();
	const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
	const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
	return `${weekday} ${date}, ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
}

const Assistant = defineExtension({
	name: "assistant",
	sections: [
		section(
			"preamble",
			() =>
				[
					"You run in pi, an assistant app on the user's phone; your conversation and the user's credentials stay on the device. Reply in Traditional Chinese (Taiwan) unless the user writes otherwise; Markdown, concise for a small screen.",
					"A ```mermaid block is drawn as a diagram (flowchart, sequence, state, class, ER, xychart-beta): use one when a picture explains better than prose, laid out top-down (flowchart TD) to fit the narrow screen.",
					"Users type short and casual (「明天有啥」「附近咖啡」「週六爬山 記一下」): act on the obvious intent; ask only when a wrong guess costs something.",
					"Vague times: pick a default, act, and say it. 等等、待會 +30 min; 晚點 +2 h; 早上 09:00; 中午 12:00; 下午 14:00; 晚上 19:00 (今晚提醒 21:00); 週末 Saturday. Events last 1 h, outings 3 h. 「記一下」 with a time means a calendar event.",
					"Text outside thinking is shown, also before tool calls: do date math in thinking, and usually call tools without a preface.",
					"Tool calls asked for in one turn run at the same time: ask for every lookup you already know you need together (each search, page, place, and the calendar), not one per turn; wait only for what depends on an earlier result.",
					`Today: ${today()}. The time of day is not given here: read it with device_info before anything that depends on it (今晚, 等等, an alarm or event today).`,
				].join("\n"),
			{ tag: false },
		),
	],
});

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

function webSearchConfig(configs: readonly ProviderConfig[], keys: Record<string, string>, lists: Record<string, string[]>, infos: readonly ModelInfo[]) {
	const custom = configs.find((config) => config.kind === "custom");
	if (custom?.kind === "custom") return { baseUrl: custom.baseUrl, apiKey: keys[custom.id] ?? "", modelIds: lists[custom.id] ?? [] };
	const ids = (provider: string) => infos.filter((info) => info.provider === provider).map((info) => info.id);
	const keyed = (provider: string) => configs.some((config) => config.id === provider) && Boolean(keys[provider]);
	if (keyed("openai")) return { baseUrl: "https://api.openai.com", apiKey: keys.openai ?? "", modelIds: ids("openai") };
	if (keyed("anthropic")) return { baseUrl: "https://api.anthropic.com", apiKey: keys.anthropic ?? "", modelIds: ids("anthropic") };
	return { baseUrl: "", apiKey: "", modelIds: [] };
}

function labelOf(extension: string, mcp: McpHub): string {
	const server = mcp.servers.find((candidate) => extensionName(candidate) === extension);
	if (server) return `${server.name} (a service the user connected)`;
	return TOOLSETS.find((toolset) => toolset.extensions.includes(extension))?.label ?? extension;
}

function cloudConnections(settings: Settings) {
	const gcloudCredential = settings.gcloudCredential ? checkGcloudCredential(settings.gcloudCredential) : undefined;
	const cloudflareCredential = settings.cloudflareCredential ? checkCloudflareCredential(settings.cloudflareCredential) : undefined;
	const azureCredential = settings.azureCredential ? checkAzureCredential(settings.azureCredential) : undefined;
	const gcloud = gcloudCredential?.ok ? new GcloudTokens(gcloudCredential.value) : undefined;
	const cloudflare = cloudflareCredential?.ok ? new CloudflareTokens(cloudflareCredential.value, saveCloudflareCredential) : undefined;
	const azure = azureCredential?.ok ? new AzureTokens(azureCredential.value, saveAzureCredential) : undefined;
	const project = settings.gcloudProject || gcloud?.project;
	const minted: Record<string, MintedService> = {};
	const services: CloudService[] = [];
	if (gcloud) {
		minted.gcloud = { get: () => gcloud.get(), env: project ? { CLOUDSDK_CORE_PROJECT: project } : {} };
		services.push(googleService(async () => (await gcloud.get()).token, project));
	}
	if (cloudflare) {
		minted.cloudflare = { get: () => cloudflare.get(), env: cloudflare.accountId ? { CLOUDFLARE_ACCOUNT_ID: cloudflare.accountId } : {} };
		services.push(cloudflareService(async () => (await cloudflare.get()).token, cloudflare.accountId));
	}
	if (azure) {
		minted.azure = { get: (scope) => azure.get(scope), env: azure.env };
		services.push(azureService(async (scope) => (await azure.get(scope)).token, azure.env.AZURE_SUBSCRIPTION_ID));
	}
	return { minted, services };
}

export type ToolCost = Record<string, { offered: number; deferred: number; tools: string[] }>;

export interface TriggerState {
	items: Trigger[];
	next: Record<string, number>;
}

function startOfToday(): number {
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	return today.getTime();
}

export class AgentRuntime {
	readonly models: ModelInfo[];
	readonly #harness: Harness;
	readonly #settings: Settings;
	readonly #computers: Computers;
	readonly #choices: Map<string, string | undefined>;
	#botListeners = new Set<(bots: Bot[]) => void>();
	readonly #folders: Map<string, string>;
	#triggerListeners = new Set<(state: TriggerState) => void>();
	#memoryListeners = new Set<() => void>();
	#triggerState: TriggerState = { items: [], next: {} };
	#triggered = new Set<ConversationId>();
	readonly #installed: () => ReadonlySet<string>;
	readonly mcp: McpHub;
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
	}

	get hasSandbox(): boolean {
		return this.#computers.any;
	}

	computerOf(id: ConversationId): Computer {
		return this.#computers.resolve(this.#choices.get(String(id)));
	}

	computers(): Computer[] {
		return this.#computers.list();
	}

	hostOf(key: string): Host | undefined {
		return this.#computers.host(key);
	}

	sandboxOf(id: ConversationId | string): Sandbox | undefined {
		return this.#computers.sandbox(this.#computers.resolve(this.#choices.get(String(id))).key);
	}

	async setComputer(id: ConversationId, key: string): Promise<void> {
		await this.#editBots((items) => {
			const bot = items.find((candidate) => candidate.id === id);
			if (bot) bot.computer = key;
		});
	}

	folderOf(id: ConversationId): { path: string; where: string } | undefined {
		const folder = this.#folders.get(String(id));
		const sandbox = this.sandboxOf(id);
		if (!sandbox || !folder) return undefined;
		const name = this.computerOf(id).name;
		return { path: sandbox.root(folder), where: sandbox.direct ? name : `${name} 的容器` };
	}

	static startModelList(settings: Settings): Promise<Record<string, string[]>> {
		const lists = parseProviders(settings.providers)
			.filter((provider) => provider.kind === "custom")
			.map(async (provider): Promise<[string, string[]]> => {
				if (provider.kind !== "custom") return [provider.id, []];
				const key = `pi-mobile.models:${provider.baseUrl}`;
				const fresh = fetchModelIds(provider.baseUrl, settings.providerKeys[provider.id] ?? "", AbortSignal.timeout(5000)).then((ids) => {
					if (ids.length > 0) localStorage.setItem(key, JSON.stringify(ids));
					return ids;
				});
				const refreshed = orLogged(fresh, "models.refresh_failed", [], { provider: provider.id });
				const cached = readStored(Type.Array(Type.String()), key) ?? [];
				return [provider.id, cached.length > 0 ? cached : await refreshed];
			});
		return Promise.all(lists).then(Object.fromEntries);
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
		const compactAt = settings.compactAt;
		const configs = usableProviders(settings);
		const [lists, loaded, catalog] = await Promise.all([
			(options.modelIds ?? AgentRuntime.startModelList(settings)).catch((error: unknown): Record<string, string[]> => {
				options.onReport?.(`model list unavailable: ${messageOf(error)}`);
				return {};
			}),
			Promise.all(
				configs.map(async (config) => {
					if (config.kind !== "builtin") return undefined;
					const provider = await builtinInfo(config.id)?.load();
					const signIn = parseOAuthCredential(settings.providerOAuth[config.id] ?? "");
					if (!provider || !signIn) return provider;
					const allowed = await chatgptModelsCached(signIn);
					return allowed ? withOnlyModels(provider, allowed) : provider;
				}),
			),
			gatewayCatalog(configs),
		]);
		const credentials = memoryCredentials(
			Object.fromEntries(configs.map((config) => [config.id, settings.providerKeys[config.id] ?? ""])),
			settings.providerOAuth,
			(id, json) => void saveProviderOAuth(id, json).catch((error: unknown) => log.warn("provider.oauth_save_failed", { id, error: String(error) })),
		);
		const models = createModels({ credentials });
		const infos: ModelInfo[] = [];
		configs.forEach((config, index) => {
			const name = providerName(config);
			if (config.kind === "custom") {
				const ids = lists[config.id] ?? [];
				const provider = customProvider(config, settings.providerKeys[config.id] ?? "", ids, catalog);
				models.setProvider(withCompaction(provider, compactAt));
				for (const model of provider.getModels()) infos.push(describe(model, name, compactAt, inCatalog(catalog, model.id)));
				return;
			}
			const provider = loaded[index];
			if (!provider) return;
			models.setProvider(withCompaction(provider, compactAt));
			for (const model of provider.getModels()) infos.push(describe(model, name, compactAt));
		});

		const registry = createRegistry();
		let runtimeRef: AgentRuntime | undefined;
		const triggerHost: TriggerHost = {
			changed: () => void runtimeRef?.syncTriggers(),
			notify: async (title, text, conversationId) => {
				const bot = (await runtimeRef?.bots())?.find((candidate) => candidate.id === conversationId);
				return (await options.notify?.(title, text, conversationId, bot && avatarOf(bot))) ?? false;
			},
		};
		const folders = new Map<string, string>();
		const clouds = cloudConnections(settings);
		const choices = new Map<string, string | undefined>();
		const computers = new Computers(settings, clouds.minted);
		const sandboxOf = (id: string) => computers.sandbox(computers.resolve(choices.get(id)).key);
		const mcp: McpHub = new McpHub({
			install: (extension) => registry.install(extension),
			uninstall: (name) => registry.uninstall({ name }),
			openUrl: (url) => options.openUrl?.(url) ?? Promise.reject(new Error("cannot open the browser here")),
		});
		for (const extension of builtinExtensions({
			assistant: Assistant,
			calendarAccess: parseCalendarAccess(settings.calendarAccess),
			...(settings.githubToken ? { githubToken: async () => settings.githubToken || undefined } : {}),
			clouds: clouds.services,
			web: webSearchConfig(configs, settings.providerKeys, lists, infos),
			triggers: triggerHost,
			memory: { changed: () => void runtimeRef?.publishMemory() },
			sandbox: { sandboxOf, folderOf: (id: string) => folders.get(id) },
			hostOf: (id: string) => computers.host(computers.resolve(choices.get(id)).key),
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
		await runtime.syncTriggers().catch((error: unknown) => options.onReport?.(`排程同步失敗：${messageOf(error)}`));
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
		await this.syncTriggers().catch((error: unknown) => log.warn("triggers.sync_failed", { error: messageOf(error) }));
	}

	async removeBot(id: ConversationId): Promise<void> {
		const bots = await this.bots();
		const bot = bots.find((candidate) => candidate.id === id);
		if (!bot) return;
		if (bots.length === 1) throw new Error("至少要留一個 Bot");
		await Promise.all(
			this.#computers
				.list()
				.map((computer) => this.#computers.sandbox(computer.key))
				.filter((sandbox) => sandbox && !sandbox.direct)
				.map((sandbox) => sandbox && orLogged(sandbox.remove(bot.folder), "bot.remove_container_folder_failed", undefined, { bot: bot.folder })),
		);
		await orLogged(removePhoneFolder(bot.folder), "bot.remove_phone_folder_failed", undefined, { bot: bot.folder });
		await this.#editTriggers((items) => items.filter((item) => item.conversationId !== id));
		await orLogged(deleteAttachments({ conversationId: String(id) }), "bot.remove_attachments_failed", undefined, { bot: String(id) });
		await this.#harness.commit(async (tx) => {
			const items = (await tx.doc(BotIndex)).items;
			const at = items.findIndex((candidate) => candidate.id === id);
			if (at >= 0) items.splice(at, 1);
			await tx.retireDoc(BotMemoryDoc, id);
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
					if (content.length > 0) {
						await this.#editBots((items) => {
							const bot = items.find((candidate) => candidate.id === id);
							if (bot) bot.updatedAt = Date.now();
						});
					}
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
		const notHere = new Set(this.sandboxOf(id) ? ["files"] : ["sandbox", "computer"]);
		return this.#allToolsets().map((toolset) => ({
			...toolset,
			available: !notHere.has(toolset.id) && toolset.extensions.every((name) => installed.has(name)),
			enabled: isEnabled(selection, toolset),
		}));
	}

	setToolset(id: ConversationId, toolset: ToolsetId | string, enabled: boolean): Promise<void> {
		const change = this.#toolsetWrites.then(async () => {
			const target = this.#allToolsets().find((candidate) => candidate.id === toolset);
			const conversation = await this.#harness.conversation(id, context);
			if (!target || !conversation) return;
			const selection = withToolset(selectionOf(await this.#harness.snapshot(AgentDoc, id, context)), target, enabled);
			const named = (names: string[]) => names.map((name) => ({ name }));
			await conversation.configure(
				{ extensions: selection.add.length + selection.remove.length > 0 ? { add: named(selection.add), remove: named(selection.remove) } : null },
				context,
			);
		});
		this.#toolsetWrites = settled(change);
		return change;
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

	subscribeTriggers(listener: (state: TriggerState) => void): () => void {
		this.#triggerListeners.add(listener);
		listener(this.#triggerState);
		return () => this.#triggerListeners.delete(listener);
	}

	async syncTriggers(): Promise<void> {
		const items = (await this.#harness.snapshot(TriggerDoc, context))?.items ?? [];
		const avatars = new Map((await this.bots()).map((bot) => [bot.id, avatarOf(bot)]));
		const schedules = items
			.filter((item) => item.enabled)
			.map(({ id, name, when, conversationId }) => ({ id, name, when, avatar: avatars.get(conversationId) }));
		const next = nativeTriggers ? (await Triggers.sync({ schedules })).next : {};
		this.#triggerState = { items: [...items], next };
		for (const listener of this.#triggerListeners) listener(this.#triggerState);
	}

	async #editTriggers(edit: (items: Trigger[]) => Trigger[]): Promise<void> {
		await this.#harness.commit(async (tx) => {
			const doc = await tx.doc(TriggerDoc);
			doc.items = edit(doc.items);
		}, context);
		await this.syncTriggers();
	}

	setTriggerEnabled(id: string, enabled: boolean): Promise<void> {
		return this.#editTriggers((items) => items.map((item) => (item.id === id ? { ...item, enabled } : item)));
	}

	deleteTrigger(id: string): Promise<void> {
		return this.#editTriggers((items) => items.filter((item) => item.id !== id));
	}

	async runTrigger(id: string, delivery: Delivery, device?: string): Promise<ConversationId | undefined> {
		const doc = await this.#harness.snapshot(TriggerDoc, context);
		const trigger = doc?.items.find((item) => item.id === id);
		if (!trigger) return undefined;
		const today = startOfToday();
		const runsToday = (doc?.runs ?? []).filter((run) => run.at >= today);
		const overLimit =
			delivery !== "manual" &&
			(runsToday.filter((run) => run.trigger === id).length >= LIMITS.perTrigger || runsToday.length >= LIMITS.total);
		const known = new Set((await this.bots()).map((bot) => bot.id));
		const conversationId = !overLimit && known.has(trigger.conversationId) ? trigger.conversationId : undefined;
		const now = Date.now();
		await this.#harness.commit(async (tx) => {
			const triggers = await tx.doc(TriggerDoc);
			const item = triggers.items.find((candidate) => candidate.id === id);
			if (!item) return;
			if (!conversationId) {
				item.last = { at: now, delivery, error: overLimit ? "今天的執行次數已達上限" : "它的 Bot 已經刪除" };
				return;
			}
			item.last = { at: now, delivery };
			triggers.runs = [...triggers.runs.filter((run) => run.at >= today), { trigger: id, at: now }];
			if (item.when.kind === "once" && delivery !== "manual") triggers.items = triggers.items.filter((candidate) => candidate.id !== id);
		}, context);
		await this.syncTriggers();
		if (!conversationId) return undefined;
		const conversation = await this.#harness.conversation(conversationId, context);
		if (!conversation) return undefined;
		await this.#editBots((items) => {
			const bot = items.find((candidate) => candidate.id === conversationId);
			if (bot) bot.updatedAt = now;
		});
		const event = trigger.when.kind !== "daily" && trigger.when.kind !== "once" && delivery !== "manual";
		const heard = event ? (device ?? trigger.when.kind) : undefined;
		const label =
			trigger.kind === "followup"
				? "follow-up you scheduled"
				: heard
					? `schedule "${trigger.name}": ${trigger.when.kind === "headphones" ? `headphones connected (${heard})` : heard}`
					: `schedule "${trigger.name}"`;
		this.#triggered.add(conversationId);
		await conversation.submit(
			{
				type: "input",
				content: [{ type: "text", text: `[trigger] ${label}, ${new Date(now).toString()}\n\n${trigger.prompt}` }],
				entry: {
					kind: TRIGGER_ENTRY,
					data: { trigger: id, name: trigger.name, prompt: trigger.prompt, kind: trigger.kind, delivery, at: now, ...(heard ? { device: heard } : {}) },
				},
				whenBusy: "followUp",
			},
			context,
		);
		return conversationId;
	}

	takeTriggered(id: ConversationId): boolean {
		return this.#triggered.delete(id);
	}

	inspect(): Promise<unknown> {
		return this.#harness.inspect(context);
	}

	async close(): Promise<void> {
		await this.#harness.close(context);
		this.#computers.close();
	}
}

export type { ConversationId, SubmissionId };
