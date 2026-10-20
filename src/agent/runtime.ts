// The app's agent runtime: one durable Harness over on-device storage, with conversations, models, and connectors.
// No DOM rendering here; the React UI talks to it through AgentRuntime and ConversationController.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type ImageContent, type TextContent } from "@earendil-works/pi-ai";
import {
	type Conversation,
	type ConversationId,
	type ConversationView,
	createRegistry,
	defineDoc,
	defineExtension,
	type EntryId,
	Harness,
	InboxDoc,
	type SubmissionId,
	section,
	type Storage,
	type Tx,
} from "@earendil-works/pi-durable";
import { type Settings, saveAzureCredential, saveCloudflareCredential } from "../settings.ts";
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
import { createSandboxExtension, MachineSandbox, RelaySandbox, type Sandbox, SandboxTools, sandboxName } from "./sandbox/sandbox.ts";
import { Workspace } from "./sandbox/workspace.ts";
import { createGitHubExtension } from "./tools/github.ts";
import { createWebExtension } from "./tools/web.ts";
import { createMemoryExtension, type Memory, MEMORY_LIMIT, MemoryDoc } from "./memory.ts";
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
const NEW_TITLE = "新對話";

// A type alias, not an interface: documents need JSON-assignable types.
export type ConversationSummary = {
	id: ConversationId;
	title: string;
	createdAt: number;
	updatedAt: number;
};

/** App-level list of conversations, newest first. Removing one only hides it; its transcript stays in storage. */
const ConversationIndex = defineDoc<{ items: ConversationSummary[] }>({
	kind: "app.conversations",
	version: 1,
	scope: "session",
	initial: () => ({ items: [] }),
});

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
					"You are pi, an assistant app on the user's phone; conversations and credentials stay on the device. Reply in Traditional Chinese (Taiwan) unless the user writes otherwise; Markdown, concise for a small screen.",
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
	/** New conversation holding the history before `entryId` (a user message); returns it and that message's text. */
	forkBefore(entryId: EntryId): Promise<{ id: ConversationId; text: string }>;
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

/** Services whose tokens the phone mints for the sandbox; a credential that does not parse is left out (settings say why). */
function mintedServices(settings: Settings): Record<string, MintedService> {
	const services: Record<string, MintedService> = {};
	try {
		if (settings.gcloudCredential) {
			const tokens = new GcloudTokens(settings.gcloudCredential);
			const project = settings.gcloudProject || tokens.project;
			services.gcloud = { get: () => tokens.get(), env: project ? { CLOUDSDK_CORE_PROJECT: project } : {} };
		}
	} catch {
		// Unusable credential: settings show why.
	}
	try {
		if (settings.cloudflareCredential) {
			const tokens = new CloudflareTokens(settings.cloudflareCredential, saveCloudflareCredential);
			services.cloudflare = { get: () => tokens.get(), env: tokens.accountId ? { CLOUDFLARE_ACCOUNT_ID: tokens.accountId } : {} };
		}
	} catch {
		// Unusable credential: settings show why.
	}
	try {
		if (settings.azureCredential) {
			const tokens = new AzureTokens(settings.azureCredential, saveAzureCredential);
			services.azure = { get: (scope) => tokens.get(scope), env: tokens.env };
		}
	} catch {
		// Unusable credential: settings show why.
	}
	return services;
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
function openSandbox(settings: Settings): Sandbox | undefined {
	const machine = parseMachines(settings.machines).find((candidate) => candidate.id === settings.sandboxMachine);
	if (machine) return new MachineSandbox(machine);
	if (settings.sandboxUrl && settings.sandboxToken) return new RelaySandbox({ url: settings.sandboxUrl, token: settings.sandboxToken });
	return undefined;
}

export class AgentRuntime {
	readonly models: ModelInfo[];
	readonly #harness: Harness;
	readonly #settings: Settings;
	readonly #sandbox: Sandbox | undefined;
	#indexListeners = new Set<(items: ConversationSummary[]) => void>();
	/** Latest conversation list, to name a sandbox in a GitHub write approval. */
	#titles = new Map<string, string>();
	#egress: EgressLink | undefined;
	#triggerListeners = new Set<(state: TriggerState) => void>();
	#memoryListeners = new Set<(memory: Memory) => void>();
	#triggerState: TriggerState = { items: [], next: {} };
	/** Conversations whose current run a trigger started. */
	#triggered = new Set<ConversationId>();

	private constructor(harness: Harness, settings: Settings, models: ModelInfo[], sandbox: Sandbox | undefined) {
		this.#harness = harness;
		this.#settings = settings;
		this.models = models;
		this.#sandbox = sandbox;
		// The relay's proxy signs the container's CLIs in with the phone's credentials; a machine uses its own.
		if (sandbox?.kind === "relay") {
			this.#egress = new EgressLink({
				relayUrl: settings.sandboxUrl,
				relayToken: settings.sandboxToken,
				githubToken: settings.githubToken || undefined,
				minted: mintedServices(settings),
				describe: (name) => this.#titles.get(name),
			});
			void this.#publishIndex();
		}
	}

	get hasSandbox(): boolean {
		return this.#sandbox !== undefined;
	}

	static async open(
		storage: Storage,
		settings: Settings,
		options: {
			onReport?: (message: string) => void;
			/** Post a notification opening the conversation, unless the user is looking at pi; resolves whether it did. */
			notify?: (title: string, text: string, conversationId: ConversationId) => Promise<boolean>;
		} = {},
	): Promise<AgentRuntime> {
		const timeout = AbortSignal.timeout(5000);
		const modelIds = await fetchModelIds(settings.baseUrl, settings.apiKey, timeout).catch((error: unknown) => {
			options.onReport?.(`model list unavailable: ${error instanceof Error ? error.message : String(error)}`);
			return [];
		});
		const models = createModels();
		models.setProvider(modelServiceProvider(settings.baseUrl, settings.apiKey, modelIds));

		const registry = createRegistry();
		registry.install(Assistant);
		registry.install(DeviceExtension);
		registry.install(AppsExtension);
		registry.install(createCalendarExtension(parseCalendarAccess(settings.calendarAccess)));
		for (const extension of createPhoneCodemode()) registry.install(extension);
		registry.install(createGitHubExtension(async () => settings.githubToken || undefined));
		registry.install(createWebExtension({ baseUrl: settings.baseUrl, apiKey: settings.apiKey, modelIds }));
		// The tools need the runtime, which exists only after the Harness opens.
		let runtimeRef: AgentRuntime | undefined;
		const triggerHost: TriggerHost = {
			changed: () => void runtimeRef?.syncTriggers(),
			notify: (title, text, conversationId) => options.notify?.(title, text, conversationId) ?? Promise.resolve(false),
		};
		registry.install(createTriggerExtension(triggerHost));
		registry.install(createMemoryExtension({ changed: () => void runtimeRef?.publishMemory() }));
		const sandbox = openSandbox(settings);
		if (sandbox) {
			registry.install(createSandboxExtension(sandbox));
			registry.install(SandboxTools);
		}

		const harness = await Harness.open(
			storage,
			{
				models,
				registry,
				onReport: (error) => options.onReport?.(error instanceof Error ? error.message : String(error)),
				...(sandbox ? { env: ({ conversationId }) => sandbox.env(conversationId) } : {}),
			},
			context,
		);
		const runtime = new AgentRuntime(harness, settings, describeModels(modelIds.length > 0 ? modelIds : FAVORITE_MODEL_IDS), sandbox);
		runtimeRef = runtime;
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

	async conversations(): Promise<ConversationSummary[]> {
		const index = await this.#harness.snapshot(ConversationIndex, context);
		return [...(index?.items ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
	}

	subscribeConversations(listener: (items: ConversationSummary[]) => void): () => void {
		this.#indexListeners.add(listener);
		void this.conversations().then(listener);
		return () => this.#indexListeners.delete(listener);
	}

	async #publishIndex(): Promise<void> {
		const items = await this.conversations();
		this.#titles = new Map(items.map((item) => [sandboxName(item.id), item.title]));
		for (const listener of this.#indexListeners) listener(items);
	}

	async #editIndex(edit: (items: ConversationSummary[]) => void): Promise<void> {
		await this.#harness.commit(async (tx) => edit((await tx.doc(ConversationIndex)).items), context);
		await this.#publishIndex();
	}

	async createConversation(title = NEW_TITLE): Promise<ConversationId> {
		const conversation = await this.#harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: this.#defaultAgent(),
				init: async (tx, id) => {
					const now = Date.now();
					(await tx.doc(ConversationIndex)).items.push({ id, title, createdAt: now, updatedAt: now });
				},
			},
			context,
		);
		await this.#publishIndex();
		return conversation.id;
	}

	renameConversation(id: ConversationId, title: string): Promise<void> {
		return this.#editIndex((items) => {
			const item = items.find((candidate) => candidate.id === id);
			if (item) item.title = title;
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

	/** The conversation's sandbox files, or undefined when it has no sandbox yet. */
	async workspace(id: ConversationId): Promise<Workspace | undefined> {
		if (!this.#sandbox || !(await this.#sandbox.exists(id))) return undefined;
		return new Workspace(this.#sandbox.env(id), this.#sandbox.root(id));
	}

	/** Delete the conversation's sandbox container and files; the conversation itself stays. */
	async resetSandbox(id: ConversationId): Promise<void> {
		if (!this.#sandbox) throw new Error("No sandbox configured");
		await this.#sandbox.remove(id);
	}

	removeConversation(id: ConversationId): Promise<void> {
		void this.#sandbox?.remove(id).catch(() => undefined);
		return this.#editIndex((items) => {
			const at = items.findIndex((candidate) => candidate.id === id);
			if (at >= 0) items.splice(at, 1);
		});
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
					await this.#editIndex((items) => {
						const item = items.find((candidate) => candidate.id === id);
						if (!item) return;
						item.updatedAt = Date.now();
						if (item.title === NEW_TITLE && text) item.title = text.length > 24 ? `${text.slice(0, 24)}…` : text;
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
			forkBefore: async (entryId) => {
				const entries = view.value.entries;
				const at = entries.findIndex((entry) => entry.id === entryId);
				const text = contentText(entries[at]?.model?.[0]?.content);
				const previous = at > 0 ? entries[at - 1] : undefined;
				const title = `分支：${text.length > 20 ? `${text.slice(0, 20)}…` : text}`;
				const init = async (tx: Tx, forkId: ConversationId) => {
					const now = Date.now();
					(await tx.doc(ConversationIndex)).items.push({ id: forkId, title, createdAt: now, updatedAt: now });
				};
				const fork = previous
					? await conversation.fork(previous.id, { ownership: { kind: "ownerless" }, init }, context)
					: await this.#harness.createConversation({ ownership: { kind: "ownerless" }, init, agent: this.#defaultAgent() }, context);
				await this.#publishIndex();
				return { id: fork.id, text };
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

	async memory(): Promise<Memory> {
		return { ...((await this.#harness.snapshot(MemoryDoc, context)) ?? { text: "", updatedAt: 0, updatedBy: "" }) };
	}

	/** Calls `listener` now and whenever the user or the agent changes MEMORY.md. */
	subscribeMemory(listener: (memory: Memory) => void): () => void {
		this.#memoryListeners.add(listener);
		void this.memory().then(listener);
		return () => this.#memoryListeners.delete(listener);
	}

	async publishMemory(): Promise<void> {
		const memory = await this.memory();
		for (const listener of this.#memoryListeners) listener(memory);
	}

	/** The user's edit of MEMORY.md. */
	async saveMemory(text: string): Promise<void> {
		const trimmed = text.trim();
		if (trimmed.length > MEMORY_LIMIT) throw new Error(`記憶最多 ${MEMORY_LIMIT} 字，現在是 ${trimmed.length} 字`);
		await this.#harness.commit(async (tx) => {
			const memory = await tx.doc(MemoryDoc);
			memory.text = trimmed;
			memory.updatedAt = Date.now();
			memory.updatedBy = "user";
		}, context);
		await this.publishMemory();
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
	async runTrigger(id: string, delivery: Delivery): Promise<ConversationId | undefined> {
		const doc = await this.#harness.snapshot(TriggerDoc, context);
		const trigger = doc?.items.find((item) => item.id === id);
		if (!trigger) return undefined;
		const today = startOfToday();
		const runsToday = (doc?.runs ?? []).filter((run) => run.at >= today);
		const overLimit =
			delivery !== "manual" &&
			(runsToday.filter((run) => run.trigger === id).length >= LIMITS.perTrigger || runsToday.length >= LIMITS.total);
		const known = new Set((await this.conversations()).map((item) => item.id));
		let conversationId: ConversationId | undefined;
		if (!overLimit) {
			conversationId =
				trigger.target !== "new" && trigger.conversationId && known.has(trigger.conversationId)
					? trigger.conversationId
					: await this.createConversation(trigger.name);
		}
		const now = Date.now();
		await this.#harness.commit(async (tx) => {
			const triggers = await tx.doc(TriggerDoc);
			const item = triggers.items.find((candidate) => candidate.id === id);
			if (!item) return;
			if (overLimit) {
				item.last = { at: now, delivery, error: "今天的執行次數已達上限" };
				return;
			}
			item.last = { at: now, delivery, conversationId };
			if (item.target === "thread") item.conversationId = conversationId;
			triggers.runs = [...triggers.runs.filter((run) => run.at >= today), { trigger: id, at: now }];
			// A one-time schedule is done once it ran (not when run by hand from Settings).
			if (item.when.kind === "once" && delivery !== "manual") triggers.items = triggers.items.filter((candidate) => candidate.id !== id);
		}, context);
		await this.syncTriggers();
		if (!conversationId) return undefined;
		const conversation = await this.#harness.conversation(conversationId, context);
		if (!conversation) return undefined;
		await this.#editIndex((items) => {
			const item = items.find((candidate) => candidate.id === conversationId);
			if (item) item.updatedAt = now;
		});
		const label = trigger.target === "origin" ? "follow-up you scheduled" : `schedule "${trigger.name}"`;
		this.#triggered.add(conversationId);
		await conversation.submit(
			{
				type: "input",
				content: [{ type: "text", text: `[trigger] ${label}, ${new Date(now).toString()}\n\n${trigger.prompt}` }],
				entry: {
					kind: TRIGGER_ENTRY,
					data: { trigger: id, name: trigger.name, prompt: trigger.prompt, target: trigger.target, delivery, at: now },
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
