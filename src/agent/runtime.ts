// The app's agent runtime: one durable Harness over on-device storage, with bots (one long conversation each), models,
// and connectors.
// No DOM rendering here; the React UI talks to it through AgentRuntime and ConversationController.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type ImageContent, type TextContent } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	type Conversation,
	type ConversationId,
	type ConversationView,
	createRegistry,
	defineExtension,
	type EntryId,
	Harness,
	InboxDoc,
	type SubmissionId,
	section,
	type Storage,
} from "@earendil-works/pi-durable";
import { builtinExtensions } from "./catalog.ts";
import { type Computer, Computers } from "./computers.ts";
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
import { AzureTokens } from "./azure.ts";
import { CloudflareTokens } from "./cloudflare.ts";
import { GcloudTokens } from "./gcloud.ts";
import type { MintedService } from "./sandbox/egress.ts";
import { MachineSandbox, type Sandbox } from "./sandbox/sandbox.ts";
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

const context = BACKGROUND_CONTEXT;

/** The local date with its weekday and time zone, such as "Tuesday 2026-10-20, Asia/Taipei"; no time, so the prompt stays cacheable all day. */
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

/** How input sent while the agent works is placed: after the current tool round, or after the whole run. */
export type BusyMode = "steer" | "followUp";

export interface ConversationController {
	readonly id: ConversationId;
	subscribe(listener: (view: ConversationView) => void): () => void;
	send(content: UserContent, whenBusy?: BusyMode): Promise<void>;
	/** Withdraw one queued input. */
	withdraw(submissionId: SubmissionId): Promise<void>;
	/** Stop the run. Queued inputs are withdrawn and their text returned, so the UI can put it back in the editor. */
	stop(): Promise<string[]>;
	/** Summarize older entries; resolves whether a summary was written (short conversations have nothing to compact). */
	compact(): Promise<boolean>;
	/** Start a new context in this conversation: the model no longer sees earlier entries. */
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

/**
 * Where web_search runs: the provider's own search, OpenAI's Responses web_search or Anthropic's server tool. A custom
 * endpoint first (a gateway usually serves both), else OpenAI, else Anthropic, with a key; none disables it.
 */
function webSearchConfig(configs: readonly ProviderConfig[], keys: Record<string, string>, lists: Record<string, string[]>, infos: readonly ModelInfo[]) {
	const custom = configs.find((config) => config.kind === "custom");
	if (custom?.kind === "custom") return { baseUrl: custom.baseUrl, apiKey: keys[custom.id] ?? "", modelIds: lists[custom.id] ?? [] };
	const ids = (provider: string) => infos.filter((info) => info.provider === provider).map((info) => info.id);
	const keyed = (provider: string) => configs.some((config) => config.id === provider) && Boolean(keys[provider]);
	if (keyed("openai")) return { baseUrl: "https://api.openai.com", apiKey: keys.openai ?? "", modelIds: ids("openai") };
	if (keyed("anthropic")) return { baseUrl: "https://api.anthropic.com", apiKey: keys.anthropic ?? "", modelIds: ids("anthropic") };
	return { baseUrl: "", apiKey: "", modelIds: [] };
}

/** A toolset's name for an extension, for the list of tools that load on demand. */
function labelOf(extension: string, mcp: McpHub): string {
	const server = mcp.servers.find((candidate) => extensionName(candidate) === extension);
	if (server) return `${server.name} (a service the user connected)`;
	return TOOLSETS.find((toolset) => toolset.extensions.includes(extension))?.label ?? extension;
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/** A token source, or none when the credential does not parse (settings say why). */
function tryTokens<T>(json: string, open: (json: string) => T): T | undefined {
	if (!json) return undefined;
	try {
		return open(json);
	} catch {
		return undefined;
	}
}

/**
 * The signed-in clouds, each with one token source shared by the phone's API tools and the sandbox's egress proxy, so
 * a rotating refresh token (Cloudflare, Azure) is only ever refreshed by one owner.
 */
function cloudConnections(settings: Settings) {
	const gcloud = tryTokens(settings.gcloudCredential, (json) => new GcloudTokens(json));
	const cloudflare = tryTokens(settings.cloudflareCredential, (json) => new CloudflareTokens(json, saveCloudflareCredential));
	const azure = tryTokens(settings.azureCredential, (json) => new AzureTokens(json, saveAzureCredential));
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

/** Per extension: characters of tool definitions in every request (offered) and loadable on demand (deferred). */
export type ToolCost = Record<string, { offered: number; deferred: number; tools: string[] }>;

/** Triggers with the next time each fires, for Settings. */
export interface TriggerState {
	items: Trigger[];
	next: Record<string, number>;
}

function startOfToday(): number {
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	return today.getTime();
}

/** The chosen machine over SSH, else the relay when paired, else none. */
export class AgentRuntime {
	readonly models: ModelInfo[];
	readonly #harness: Harness;
	readonly #settings: Settings;
	readonly #computers: Computers;
	/** Each bot's choice of computer, by conversation id (Bot.computer). */
	readonly #choices: Map<string, string | undefined>;
	#botListeners = new Set<(bots: Bot[]) => void>();
	/** Each bot's folder in the sandbox, by conversation id; the sandbox section and environments read it. */
	readonly #folders: Map<string, string>;
	#triggerListeners = new Set<(state: TriggerState) => void>();
	#memoryListeners = new Set<() => void>();
	#triggerState: TriggerState = { items: [], next: {} };
	/** Conversations whose current run a trigger started. */
	#triggered = new Set<ConversationId>();
	/** Names of the installed extensions: which toolsets this phone has set up. */
	readonly #installed: () => ReadonlySet<string>;
	/** The MCP servers from settings and their connections. */
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

	/** Whether the user has a computer besides the phone. */
	get hasSandbox(): boolean {
		return this.#computers.any;
	}

	/** Where a bot's tools run, by its choice or the default. */
	computerOf(id: ConversationId): Computer {
		return this.#computers.resolve(this.#choices.get(String(id)));
	}

	/** The computers a bot can pick. */
	computers(): Computer[] {
		return this.#computers.list();
	}

	/** A bot's sandbox, undefined when it works on the phone. */
	sandboxOf(id: ConversationId | string): Sandbox | undefined {
		return this.#computers.sandbox(this.#computers.resolve(this.#choices.get(String(id))).key);
	}

	/** Move a bot to another computer; its next tool call runs there. Files stay where they were. */
	async setComputer(id: ConversationId, key: string): Promise<void> {
		await this.#editBots((items) => {
			const bot = items.find((candidate) => candidate.id === id);
			if (bot) bot.computer = key;
		});
	}

	/** Where a bot works: its folder's path, and the sandbox it is in, in words; undefined without a sandbox. */
	folderOf(id: ConversationId): { path: string; where: string } | undefined {
		const folder = this.#folders.get(String(id));
		const sandbox = this.sandboxOf(id);
		if (!sandbox || !folder) return undefined;
		if (sandbox instanceof MachineSandbox) {
			return { path: sandbox.root(folder), where: `${sandbox.machine.name} 的${sandbox.direct ? "帳號（直接模式）" : "容器"}` };
		}
		return { path: sandbox.root(folder), where: `${this.computerOf(id).name} 的容器` };
	}

	/**
	 * Each custom provider's models. The list from the last start when there is one, so starting does not wait on the
	 * network (over Tailscale or a phone network that took up to 0.7 s); the endpoint is asked anyway and its answer
	 * kept for the next start. The first start waits for it.
	 */
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
				let cached: unknown;
				try {
					cached = JSON.parse(localStorage.getItem(key) ?? "null");
				} catch {
					cached = null;
				}
				if (Array.isArray(cached) && cached.length > 0 && cached.every((id) => typeof id === "string")) {
					fresh.catch((error: unknown) => log.warn("models.refresh_failed", { error: error instanceof Error ? error.message : String(error) }));
					return [provider.id, cached];
				}
				return [provider.id, await fresh.catch(() => [])];
			});
		return Promise.all(lists).then(Object.fromEntries);
	}

	static async open(
		storage: Storage,
		settings: Settings,
		options: {
			onReport?: (message: string) => void;
			/** Post a notification opening the conversation, unless the user is looking at pi; resolves whether it did. */
			notify?: (title: string, text: string, conversationId: ConversationId, avatar: string | undefined) => Promise<boolean>;
			/** Open a URL in the user's browser, for MCP sign-ins. */
			openUrl?: (url: string) => Promise<void>;
			/** The global MEMORY.md from before bots, written once when the new one is empty. */
			importMemory?: string;
			/** The custom providers' lists, already asked for while storage opened (startModelList). */
			modelIds?: Promise<Record<string, string[]>>;
		} = {},
	): Promise<AgentRuntime> {
		const compactAt = settings.compactAt;
		const configs = usableProviders(settings);
		const [lists, loaded, catalog] = await Promise.all([
			(options.modelIds ?? AgentRuntime.startModelList(settings)).catch((error: unknown): Record<string, string[]> => {
				options.onReport?.(`model list unavailable: ${error instanceof Error ? error.message : String(error)}`);
				return {};
			}),
			// Built-in providers, each its own chunk with its catalog. Signed in with ChatGPT, OpenAI offers only the models
			// the subscription may use.
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
		// API keys go through pi-ai's credential store, as each provider's auth resolves them.
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
		// The tools need the runtime, which exists only after the Harness opens.
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
			labelOf: (name) => labelOf(name, mcp),
		})) {
			registry.install(extension);
		}
		const harness = await Harness.open(
			storage,
			{
				models,
				registry,
				// Built-in toolsets by default; services only where a bot adds them (toolsets.ts).
				settings: {
					get extensions() {
						return registry
							.snapshot()
							.installed()
							.filter((extension) => !extension.name.startsWith("mcp-"));
					},
				},
				onReport: (error) => options.onReport?.(error instanceof Error ? error.message : String(error)),
				// The bot's folder in the sandbox when there is one, and otherwise its folder on the phone.
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
		// In the background: the tools from the last connection are installed already.
		mcp.refreshAll();
		runtimeRef = runtime;
		// The folders must be known before a run resumes and asks for its environment.
		if ((await runtime.bots()).length === 0) await runtime.createBot(DEFAULT_BOT);
		else await runtime.#publishBots();
		if (options.importMemory?.trim() && !(await runtime.memory({ kind: "global" })).text) {
			await runtime.saveMemory({ kind: "global" }, options.importMemory);
		}
		await runtime.syncTriggers().catch((error: unknown) => options.onReport?.(`排程同步失敗：${error instanceof Error ? error.message : String(error)}`));
		// Scheduling starts lazily on submit or wait; start it now so runs an app kill interrupted continue at launch.
		harness.resume();
		return runtime;
	}

	/** A new bot's model: the default from settings, or the first model there is when that one is gone. */
	#defaultAgent() {
		const { defaultProvider: provider, defaultModelId: modelId } = this.#settings;
		const known = this.models.some((model) => model.provider === provider && model.id === modelId);
		const first = this.models[0];
		const model = known || !first ? { provider, modelId } : { provider: first.provider, modelId: first.id };
		const thinking = this.#settings.defaultThinking;
		return { model, thinkingLevel: isThinkingLevel(thinking) ? thinking : "low" };
	}

	/** The bots, the one talked to most recently first. */
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
		await this.syncTriggers().catch((error: unknown) => log.warn("triggers.sync_failed", { error: error instanceof Error ? error.message : String(error) }));
	}

	/**
	 * Remove a bot with its memory, schedules, attachments, and folder; the last one stays. Its transcript stays in
	 * storage, unlisted: pi-durable has no way to delete a conversation.
	 */
	async removeBot(id: ConversationId): Promise<void> {
		const bots = await this.bots();
		const bot = bots.find((candidate) => candidate.id === id);
		if (!bot) return;
		if (bots.length === 1) throw new Error("至少要留一個 Bot");
		const sandbox = this.sandboxOf(id);
		if (sandbox && !sandbox.direct) await sandbox.remove(bot.folder).catch(() => undefined);
		await removePhoneFolder(bot.folder).catch(() => undefined);
		await this.#editTriggers((items) => items.filter((item) => item.conversationId !== id));
		await deleteAttachments({ conversationId: String(id) }).catch(() => undefined);
		await this.#harness.commit(async (tx) => {
			const items = (await tx.doc(BotIndex)).items;
			const at = items.findIndex((candidate) => candidate.id === id);
			if (at >= 0) items.splice(at, 1);
			await tx.retireDoc(BotMemoryDoc, id);
		}, context);
		await this.#publishBots();
	}

	/**
	 * Conversations with live work (runs, tool calls, compactions), from the harness's task graph. Background tasks
	 * do not count. Calls `listener` now and on every change; returns the unsubscribe function.
	 */
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

	/** A bot's folder in the sandbox, or undefined when it has not used it yet. */
	async workspace(id: ConversationId): Promise<Workspace | undefined> {
		const folder = this.#folders.get(String(id));
		const sandbox = this.sandboxOf(id);
		if (!sandbox || !folder || !(await sandbox.exists(folder))) return undefined;
		return new Workspace(await sandbox.env(folder), sandbox.root(folder));
	}

	/** A bot's folder on the phone, where its coding tools work when there is no sandbox. */
	phoneFolder(id: ConversationId): ExecutionEnv | undefined {
		const folder = this.#folders.get(String(id));
		return folder ? new PhoneEnv(folder) : undefined;
	}

	/** Empty a bot's folder in the sandbox; the bot and its conversation stay. */
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
		// Submissions still on their way to storage; stop waits for them so a queued message is never lost.
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
				// Withdraw queued input first: an abort alone would let the next queued item start a new run.
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

	/**
	 * What a bot's tools take of each request, by extension: the characters of the definitions sent (name,
	 * description, parameter schema), and of those it can load on demand.
	 */
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

	/** The built-in toolsets, then one per MCP server. */
	#allToolsets(): Toolset[] {
		return [
			...TOOLSETS,
			...this.mcp.servers.map((server) => ({
				kind: "service" as const,
				load: "on-demand" as const,
				id: extensionName(server),
				label: server.name,
				hint: hostOf(server.url),
				extensions: [extensionName(server)],
			})),
		];
	}

	/** A bot's toolsets: which this phone has set up, and which the bot may use. */
	async toolsets(id: ConversationId): Promise<ToolsetState[]> {
		const selection = selectionOf(await this.#harness.snapshot(AgentDoc, id, context));
		const installed = this.#installed();
		// The coding tools come as one of two toolsets, by where the bot works.
		const elsewhere = this.sandboxOf(id) ? "files" : "sandbox";
		return this.#allToolsets().map((toolset) => ({
			...toolset,
			available: toolset.id !== elsewhere && toolset.extensions.every((name) => installed.has(name)),
			enabled: isEnabled(selection, toolset),
		}));
	}

	/** Turn a toolset on or off for a bot; its next request has the tools or not. */
	setToolset(id: ConversationId, toolset: ToolsetId | string, enabled: boolean): Promise<void> {
		// One change at a time: each reads the stored list and writes it whole, so two quick switches would lose one.
		const change = this.#toolsetWrites.then(async () => {
			const target = this.#allToolsets().find((candidate) => candidate.id === toolset);
			const conversation = await this.#harness.conversation(id, context);
			if (!target || !conversation) return;
			const selection = withToolset(selectionOf(await this.#harness.snapshot(AgentDoc, id, context)), target, enabled);
			// Stored by name; an extension is identified by its name alone.
			const named = (names: string[]) => names.map((name) => ({ name }));
			await conversation.configure(
				{ extensions: selection.add.length + selection.remove.length > 0 ? { add: named(selection.add), remove: named(selection.remove) } : null },
				context,
			);
		});
		this.#toolsetWrites = change.catch(() => undefined);
		return change;
	}

	async memory(scope: MemoryScope): Promise<Memory> {
		const memory = scope.kind === "global" ? await this.#harness.snapshot(MemoryDoc, context) : await this.#harness.snapshot(BotMemoryDoc, scope.id, context);
		return { ...(memory ?? { text: "", updatedAt: 0, updatedBy: "" }) };
	}

	/** Calls `listener` now and whenever the user or the agent changes that MEMORY.md. */
	subscribeMemory(scope: MemoryScope, listener: (memory: Memory) => void): () => void {
		const reload = () => void this.memory(scope).then(listener);
		this.#memoryListeners.add(reload);
		reload();
		return () => this.#memoryListeners.delete(reload);
	}

	publishMemory(): void {
		for (const listener of this.#memoryListeners) listener();
	}

	/** The user's edit of a MEMORY.md. */
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

	/** Mirror the enabled schedules to the native side, which sets their alarms, and tell Settings. */
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

	/** Add a schedule as approved, without asking: for tests on a device, where approvals are always declined. */
	addTrigger(trigger: Trigger): Promise<void> {
		return this.#editTriggers((items) => [...items.filter((item) => item.id !== trigger.id), trigger]);
	}

	deleteTrigger(id: string): Promise<void> {
		return this.#editTriggers((items) => items.filter((item) => item.id !== id));
	}

	/**
	 * Submit a trigger's prompt to its conversation. Resolves the conversation, or undefined when the trigger is gone or
	 * over its daily limit (recorded as its last result). `device`: for an event schedule, what happened (the
	 * headphones that connected, 開始充電, 到了 家).
	 */
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
			// A one-time schedule is done once it ran (not when run by hand from Settings).
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
		// What happened, for an event schedule: the headphones that connected, or the event's own words (開始充電, 到了 家).
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

	/** Whether a trigger started the run that just ended in this conversation; forgets it. */
	takeTriggered(id: ConversationId): boolean {
		return this.#triggered.delete(id);
	}

	/** The global MEMORY.md of a database from before bots (src/storage.ts takeLegacyStorage), read without running it. */
	static async readLegacyMemory(storage: Storage): Promise<string> {
		const harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, context);
		try {
			return (await harness.snapshot(MemoryDoc, context))?.text ?? "";
		} finally {
			await harness.close(context);
		}
	}

	inspect(): Promise<unknown> {
		return this.#harness.inspect(context);
	}

	async close(): Promise<void> {
		await this.#harness.close(context);
		this.#computers.close();
	}
}

export type { ConversationId, EntryId, SubmissionId };
