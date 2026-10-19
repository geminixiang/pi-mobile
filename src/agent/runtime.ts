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
import type { Settings } from "../settings.ts";
import { cliProxyProvider, describeModels, FAVORITE_MODEL_IDS, fetchModelIds, type ModelInfo, PROVIDER_ID } from "./models.ts";
import { DeviceExtension } from "./tools/device.ts";
import { SandboxExtension, SandboxPool, SandboxTools } from "./sandbox/sandbox.ts";
import { createGitHubExtension } from "./tools/github.ts";

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

const Assistant = defineExtension({
	name: "assistant",
	sections: [
		section(
			"preamble",
			() =>
				[
					"You are a capable assistant running as an app on the user's phone. The conversation, its history, and the user's credentials stay on the device.",
					"Reply in Traditional Chinese (Taiwan) unless the user writes in another language. Use Markdown; keep answers concise for a small screen.",
					`Today is ${new Date().toISOString().slice(0, 10)}.`,
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

export class AgentRuntime {
	readonly models: ModelInfo[];
	readonly #harness: Harness;
	readonly #settings: Settings;
	readonly #sandbox: SandboxPool | undefined;
	#indexListeners = new Set<(items: ConversationSummary[]) => void>();

	private constructor(harness: Harness, settings: Settings, models: ModelInfo[], sandbox: SandboxPool | undefined) {
		this.#harness = harness;
		this.#settings = settings;
		this.models = models;
		this.#sandbox = sandbox;
	}

	get hasSandbox(): boolean {
		return this.#sandbox !== undefined;
	}

	static async open(
		storage: Storage,
		settings: Settings,
		options: { onReport?: (message: string) => void } = {},
	): Promise<AgentRuntime> {
		const timeout = AbortSignal.timeout(5000);
		const modelIds = await fetchModelIds(settings.baseUrl, settings.apiKey, timeout).catch((error: unknown) => {
			options.onReport?.(`model list unavailable: ${error instanceof Error ? error.message : String(error)}`);
			return [];
		});
		const models = createModels();
		models.setProvider(cliProxyProvider(settings.baseUrl, settings.apiKey, modelIds));

		const registry = createRegistry();
		registry.install(Assistant);
		registry.install(DeviceExtension);
		registry.install(createGitHubExtension(async () => settings.githubToken || undefined));
		const sandbox =
			settings.sandboxUrl && settings.sandboxToken ? new SandboxPool({ url: settings.sandboxUrl, token: settings.sandboxToken }) : undefined;
		if (sandbox) {
			registry.install(SandboxExtension);
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
		for (const listener of this.#indexListeners) listener(items);
	}

	async #editIndex(edit: (items: ConversationSummary[]) => void): Promise<void> {
		await this.#harness.commit(async (tx) => edit((await tx.doc(ConversationIndex)).items), context);
		await this.#publishIndex();
	}

	async createConversation(): Promise<ConversationId> {
		const conversation = await this.#harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: this.#defaultAgent(),
				init: async (tx, id) => {
					const now = Date.now();
					(await tx.doc(ConversationIndex)).items.push({ id, title: NEW_TITLE, createdAt: now, updatedAt: now });
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
		return {
			id,
			subscribe: (listener) => {
				listener(view.value);
				return view.subscribe(listener);
			},
			send: async (content, whenBusy = "steer") => {
				const text = content.find((part): part is TextContent => part.type === "text")?.text.trim() ?? "";
				await this.#editIndex((items) => {
					const item = items.find((candidate) => candidate.id === id);
					if (!item) return;
					item.updatedAt = Date.now();
					if (item.title === NEW_TITLE && text) item.title = text.length > 24 ? `${text.slice(0, 24)}…` : text;
				});
				await conversation.submit({ type: "input", content, whenBusy }, context);
			},
			withdraw: async (submissionId) => {
				await this.#harness.abortSubmission(submissionId, context, id);
			},
			stop: async () => {
				// Withdraw queued input first: an abort alone would let the next queued item start a new run.
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

	inspect(): Promise<unknown> {
		return this.#harness.inspect(context);
	}

	async close(): Promise<void> {
		await this.#harness.close(context);
		this.#sandbox?.close();
	}
}

export type { ConversationId, EntryId, SubmissionId };
