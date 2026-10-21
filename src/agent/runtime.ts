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
import { removedExtensions, TOOLSETS, type ToolsetId, type ToolsetState, withToolset } from "./toolsets.ts";
import { type Bot, BotExtension, BotIndex, DEFAULT_BOT, folderFor, MAX_BOTS, MAX_JOB } from "./bots.ts";
import { type Settings, saveAzureCredential, saveCloudflareCredential } from "../settings.ts";
import { log } from "../log.ts";
import { modelServiceProvider, describeModels, FAVORITE_MODEL_IDS, fetchModelIds, type ModelInfo, PROVIDER_ID } from "./models.ts";
import { parseCalendarAccess } from "./calendar-access.ts";
import { AppsExtension } from "./tools/apps.ts";
import { createCalendarExtension } from "./tools/calendar.ts";
import { DeviceExtension } from "./tools/device.ts";
import { createPhoneCodemode } from "./codemode.ts";
import { AzureTokens } from "./azure.ts";
import { CloudflareTokens } from "./cloudflare.ts";
import { GcloudTokens } from "./gcloud.ts";
import { EgressLink, type MintedService } from "./sandbox/egress.ts";
import { parseMachines } from "./sandbox/machine.ts";
import { createSandboxExtension, MachineSandbox, RelaySandbox, type Sandbox, SandboxTools, SHARED_SANDBOX } from "./sandbox/sandbox.ts";
import { Workspace } from "./sandbox/workspace.ts";
import { azureService, type CloudService, cloudflareService, createCloudExtensions, googleService } from "./tools/cloud.ts";
import { createGitHubExtension } from "./tools/github.ts";
import { SkillsExtension } from "./skills.ts";
import { NotificationsExtension } from "./tools/notifications.ts";
import { SpeechExtension } from "./tools/speech.ts";
import { createWebExtension } from "./tools/web.ts";
import { BotMemoryDoc, createMemoryExtension, type Memory, MEMORY_LIMIT, MemoryDoc, type MemoryScope } from "./memory.ts";
import {
	createTriggerExtension,
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
					`Today: ${today()}.`,
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
	setModel(modelId: string): Promise<void>;
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
function openSandbox(settings: Settings, minted: Record<string, MintedService>): Sandbox | undefined {
	const machine = parseMachines(settings.machines).find((candidate) => candidate.id === settings.sandboxMachine);
	if (machine) return new MachineSandbox(machine, { githubToken: settings.githubToken || undefined, minted });
	if (settings.sandboxUrl && settings.sandboxToken) return new RelaySandbox({ url: settings.sandboxUrl, token: settings.sandboxToken });
	return undefined;
}

export class AgentRuntime {
	readonly models: ModelInfo[];
	readonly #harness: Harness;
	readonly #settings: Settings;
	readonly #sandbox: Sandbox | undefined;
	#botListeners = new Set<(bots: Bot[]) => void>();
	/** Each bot's folder in the sandbox, by conversation id; the sandbox section and environments read it. */
	readonly #folders: Map<string, string>;
	#egress: EgressLink | undefined;
	#triggerListeners = new Set<(state: TriggerState) => void>();
	#memoryListeners = new Set<() => void>();
	#triggerState: TriggerState = { items: [], next: {} };
	/** Conversations whose current run a trigger started. */
	#triggered = new Set<ConversationId>();
	/** Names of the installed extensions: which toolsets this phone has set up. */
	readonly #installed: ReadonlySet<string>;
	#toolsetWrites: Promise<void> = Promise.resolve();

	private constructor(
		harness: Harness,
		settings: Settings,
		models: ModelInfo[],
		sandbox: Sandbox | undefined,
		folders: Map<string, string>,
		minted: Record<string, MintedService>,
		installed: ReadonlySet<string>,
	) {
		this.#installed = installed;
		this.#harness = harness;
		this.#settings = settings;
		this.models = models;
		this.#sandbox = sandbox;
		this.#folders = folders;
		// The relay's proxy asks for the phone's credentials over its control channel; a machine's proxy over SSH.
		if (sandbox?.kind === "relay") {
			this.#egress = new EgressLink({
				relayUrl: settings.sandboxUrl,
				relayToken: settings.sandboxToken,
				githubToken: settings.githubToken || undefined,
				minted,
				describe: (name) => (name === SHARED_SANDBOX ? "共用的 sandbox" : name),
			});
		}
	}

	get hasSandbox(): boolean {
		return this.#sandbox !== undefined;
	}

	/** Where a bot works: its folder's path, and the sandbox it is in, in words; undefined without a sandbox. */
	folderOf(id: ConversationId): { path: string; where: string } | undefined {
		const folder = this.#folders.get(String(id));
		const sandbox = this.#sandbox;
		if (!sandbox || !folder) return undefined;
		if (sandbox instanceof MachineSandbox) {
			return { path: sandbox.root(folder), where: `${sandbox.machine.name} 的${sandbox.contained ? "容器" : "帳號（直接模式）"}` };
		}
		return { path: sandbox.root(folder), where: "sandbox 主機的容器" };
	}

	/**
	 * The model service's models. The list from the last start when there is one, so starting does not wait on the
	 * network (over Tailscale or a phone network that took up to 0.7 s); the service is asked anyway and its answer
	 * kept for the next start. The first start waits for it.
	 */
	static startModelList(settings: Settings): Promise<string[]> {
		const key = `pi-mobile.models:${settings.baseUrl}`;
		const fresh = fetchModelIds(settings.baseUrl, settings.apiKey, AbortSignal.timeout(5000)).then((ids) => {
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
			return Promise.resolve(cached);
		}
		return fresh;
	}

	static async open(
		storage: Storage,
		settings: Settings,
		options: {
			onReport?: (message: string) => void;
			/** Post a notification opening the conversation, unless the user is looking at pi; resolves whether it did. */
			notify?: (title: string, text: string, conversationId: ConversationId) => Promise<boolean>;
			/** The global MEMORY.md from before bots, written once when the new one is empty. */
			importMemory?: string;
			/** The model service's list, already asked for while storage opened (startModelList). */
			modelIds?: Promise<string[]>;
		} = {},
	): Promise<AgentRuntime> {
		const modelIds = await (options.modelIds ?? AgentRuntime.startModelList(settings)).catch((error: unknown) => {
			options.onReport?.(`model list unavailable: ${error instanceof Error ? error.message : String(error)}`);
			return [];
		});
		const models = createModels();
		const compactAt = settings.compactAt;
		models.setProvider(modelServiceProvider(settings.baseUrl, settings.apiKey, modelIds, compactAt));

		const registry = createRegistry();
		registry.install(Assistant);
		registry.install(BotExtension);
		registry.install(DeviceExtension);
		registry.install(AppsExtension);
		registry.install(SpeechExtension);
		registry.install(NotificationsExtension);
		registry.install(SkillsExtension);
		registry.install(createCalendarExtension(parseCalendarAccess(settings.calendarAccess)));
		for (const extension of createPhoneCodemode()) registry.install(extension);
		if (settings.githubToken) registry.install(createGitHubExtension(async () => settings.githubToken || undefined));
		const clouds = cloudConnections(settings);
		for (const extension of createCloudExtensions(clouds.services)) registry.install(extension);
		registry.install(createWebExtension({ baseUrl: settings.baseUrl, apiKey: settings.apiKey, modelIds }));
		// The tools need the runtime, which exists only after the Harness opens.
		let runtimeRef: AgentRuntime | undefined;
		const triggerHost: TriggerHost = {
			changed: () => void runtimeRef?.syncTriggers(),
			notify: (title, text, conversationId) => options.notify?.(title, text, conversationId) ?? Promise.resolve(false),
		};
		registry.install(createTriggerExtension(triggerHost));
		registry.install(createMemoryExtension({ changed: () => void runtimeRef?.publishMemory() }));
		const folders = new Map<string, string>();
		const sandbox = openSandbox(settings, clouds.minted);
		if (sandbox) {
			registry.install(createSandboxExtension(sandbox, (id) => folders.get(id)));
			registry.install(SandboxTools);
		}

		const harness = await Harness.open(
			storage,
			{
				models,
				registry,
				onReport: (error) => options.onReport?.(error instanceof Error ? error.message : String(error)),
				...(sandbox
					? {
							env: ({ conversationId }) => {
								const folder = folders.get(String(conversationId));
								return folder ? sandbox.env(folder) : undefined;
							},
						}
					: {}),
			},
			context,
		);
		const runtime = new AgentRuntime(
			harness,
			settings,
			describeModels(modelIds.length > 0 ? modelIds : FAVORITE_MODEL_IDS, compactAt),
			sandbox,
			folders,
			clouds.minted,
			new Set(registry.snapshot().installed().map((extension) => extension.name)),
		);
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

	#defaultThinking() {
		return this.#settings.defaultThinking as "low";
	}

	#defaultAgent() {
		return { model: { provider: PROVIDER_ID, modelId: this.#settings.defaultModelId }, thinkingLevel: this.#defaultThinking() };
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
		for (const bot of bots) this.#folders.set(String(bot.id), bot.folder);
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
		const folder = folderFor(trimmed, existing.map((bot) => bot.folder));
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
	}

	/** Remove a bot with its folder and schedules; the last one stays. Its transcript stays in storage, unlisted. */
	async removeBot(id: ConversationId): Promise<void> {
		const bots = await this.bots();
		const bot = bots.find((candidate) => candidate.id === id);
		if (!bot) return;
		if (bots.length === 1) throw new Error("至少要留一個 Bot");
		if (this.#sandbox) await this.#sandbox.remove(bot.folder).catch(() => undefined);
		await this.#editTriggers((items) => items.filter((item) => item.conversationId !== id));
		await this.#editBots((items) => {
			const at = items.findIndex((candidate) => candidate.id === id);
			if (at >= 0) items.splice(at, 1);
		});
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
		if (!this.#sandbox || !folder || !(await this.#sandbox.exists(folder))) return undefined;
		return new Workspace(await this.#sandbox.env(folder), this.#sandbox.root(folder));
	}

	/** Empty a bot's folder in the sandbox; the bot and its conversation stay. */
	async resetSandbox(id: ConversationId): Promise<void> {
		const folder = this.#folders.get(String(id));
		if (!this.#sandbox || !folder) throw new Error("No sandbox configured");
		await this.#sandbox.remove(folder);
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
				const text = content.find((part): part is TextContent => part.type === "text")?.text.trim() ?? "";
				const submitted = (async () => {
					await this.#editBots((items) => {
						const bot = items.find((candidate) => candidate.id === id);
						if (bot && text) bot.updatedAt = Date.now();
					});
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
			setModel: (modelId) => conversation.configure({ model: { provider: PROVIDER_ID, modelId } }, context),
			setThinking: (level) => conversation.configure({ thinkingLevel: level as "low" }, context),
			dispose: () => view.dispose(),
		};
	}

	/** A bot's toolsets: which this phone has set up, and which the bot may use. */
	async toolsets(id: ConversationId): Promise<ToolsetState[]> {
		const removed = removedExtensions(await this.#harness.snapshot(AgentDoc, id, context));
		return TOOLSETS.map((toolset) => ({
			...toolset,
			available: toolset.extensions.every((name) => this.#installed.has(name)),
			enabled: !toolset.extensions.some((name) => removed.includes(name)),
		}));
	}

	/** Turn a toolset on or off for a bot; its next request has the tools or not. */
	setToolset(id: ConversationId, toolset: ToolsetId, enabled: boolean): Promise<void> {
		// One change at a time: each reads the stored list and writes it whole, so two quick switches would lose one.
		const change = this.#toolsetWrites.then(async () => {
			const target = TOOLSETS.find((candidate) => candidate.id === toolset);
			const conversation = await this.#harness.conversation(id, context);
			if (!target || !conversation) return;
			const removed = withToolset(removedExtensions(await this.#harness.snapshot(AgentDoc, id, context)), target, enabled);
			// Stored by name; an extension is identified by its name alone.
			await conversation.configure({ extensions: removed.length > 0 ? { remove: removed.map((name) => ({ name })) } : null }, context);
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
		const schedules = items.filter((item) => item.enabled).map(({ id, name, when }) => ({ id, name, when }));
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

	/**
	 * Submit a trigger's prompt to its conversation. Resolves the conversation, or undefined when the trigger is gone or
	 * over its daily limit (recorded as its last result).
	 */
	/** `device`: for a headphones schedule, the headphones that connected. */
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
		const heard = trigger.when.kind === "headphones" && delivery !== "manual" ? (device ?? "headphones") : undefined;
		const label =
			trigger.kind === "followup"
				? "follow-up you scheduled"
				: heard
					? `schedule "${trigger.name}": headphones connected (${heard})`
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
		this.#egress?.close();
		this.#sandbox?.close();
	}
}

export type { ConversationId, EntryId, SubmissionId };
