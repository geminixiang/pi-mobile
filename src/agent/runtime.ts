import { Forms, FormsDoc } from "../interaction/forms.ts";
import { type ResultCard, ResultsDoc } from "../interaction/results.ts";
import { entryText } from "./entries.ts";
import { OutsideDoc, said } from "./outside.ts";
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
	type TaskGraph,
} from "@earendil-works/pi-durable";
import { activeView } from "./active-view.ts";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { changedKeys, type Settings, withRotated } from "../settings.ts";
import { orLogged, messageOf } from "../promise.ts";
import { createAssistant } from "./assistant.ts";
import type { ContextShape, ToolCost } from "./context-shape.ts";
import { HostCommands, pairedHosts } from "./sandbox/host.ts";
import { JOB_ID, parseJob, readJob, stopJob, stopOwnedJobs, waitJob } from "../jobs/commands.ts";

const PEEK_LINES = 60;
import { agentState } from "../computer-agents/tool.ts";
import { placeOf, type Reading, readCommand, reading } from "../computer-agents/workers.ts";
import { deleteAttachments } from "./attachments.ts";
import { BotToolsets } from "./bot-toolsets.ts";
import { afterUserMessage, avatarOf, type Bot, botFields, BotIndex, botsIn, DEFAULT_BOT, LeftFolders, NEW_BOT_OFFER } from "./bots.ts";
import { uuidv7 } from "@earendil-works/pi-ai/utils/uuid";
import { builtinExtensions } from "./catalog.ts";
import { connectClouds } from "./clouds.ts";
import { extensionName, isMcpExtension, McpHub, type McpHooks } from "./mcp.ts";
import { BotMemoryDoc, emptyMemory, type Memory, MEMORY_LIMIT, MemoryDoc, type MemoryScope } from "./memory.ts";
import { isThinkingLevel, type ModelInfo } from "./models.ts";
import { hostOf } from "../parse.ts";
import type { Platform } from "./platform.ts";
import { Workspace } from "./sandbox/workspace.ts";
import { type Groups, isAt, type Place, type ServiceToolset, TOOLSETS, type ToolsetState, usable } from "./toolsets.ts";
import { TriggerRuns } from "../triggers/runs.ts";
import type { Notified, TriggerHost } from "../triggers/tool.ts";
import { type Placed, Workplaces } from "./workplaces.ts";
import { MODEL_RETRY } from "./retry.ts";

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
	results(): Promise<readonly ResultCard[]>;
	setModel(provider: string, modelId: string): Promise<void>;
	setThinking(level: string): Promise<void>;
	dispose(): void;
}

function labelOf(tool: string, extension: string, place: Place, owners: ReadonlyMap<string, Groups>, mcp: McpHub): string | undefined {
	const server = mcp.servers.find((candidate) => extensionName(candidate) === extension);
	if (server) return `${server.name} (a service the user connected)`;
	const groups = owners.get(tool);
	if (groups === undefined || groups === "always") return extension;
	return TOOLSETS.find((toolset) => groups.some((id) => id === toolset.id) && isAt(toolset, place))?.label;
}


const APPLY: Record<keyof Settings, "in_place" | "restart"> = {
	providers: "restart",
	providerKeys: "restart",
	providerOAuth: "restart",
	githubToken: "restart",
	gcloudCredential: "restart",
	gcloudProject: "restart",
	cloudflareCredential: "restart",
	azureCredential: "restart",
	calendarAccess: "restart",
	defaultProvider: "in_place",
	defaultModelId: "in_place",
	defaultThinking: "in_place",
	hosts: "in_place",
	hostKeys: "in_place",
	computer: "in_place",
	compactAt: "in_place",
	searchEngine: "in_place",
};

const USER_MESSAGES = 4;

function userSpoke(bot: Bot, at: number): void {
	bot.updatedAt = at;
	const offer = bot.rhythmOffer && afterUserMessage(bot.rhythmOffer);
	if (offer) bot.rhythmOffer = offer;
	else delete bot.rhythmOffer;
}


type Applied = "in_place" | "needs_restart";

export class AgentRuntime {
	readonly #infos: ModelInfo[];
	readonly #harness: Harness;
	#settings: Settings;
	readonly workplaces: Workplaces;
	readonly #placed: Map<string, Placed>;
	readonly #waiting = new Set<string>();
	readonly #shapes: Map<string, ContextShape>;
	#botListeners = new Set<(bots: Bot[]) => void>();
	#memoryListeners = new Set<() => void>();
	readonly #installed: () => ReadonlySet<string>;
	readonly #owners: ReadonlyMap<string, Groups>;
	readonly mcp: McpHub;
	readonly forms: Forms;
	readonly triggers: TriggerRuns;
	readonly #botToolsets: BotToolsets;
	readonly #platform: Platform;

	private constructor(
		harness: Harness,
		settings: Settings,
		platform: Platform,
		infos: ModelInfo[],
		workplaces: Workplaces,
		placed: Map<string, Placed>,
		shapes: Map<string, ContextShape>,
		installed: () => ReadonlySet<string>,
		owners: ReadonlyMap<string, Groups>,
		mcp: McpHub,
		forms: Forms,
		judge: Judge,
	) {
		this.#installed = installed;
		this.#owners = owners;
		this.#platform = platform;
		this.mcp = mcp;
		this.forms = forms;
		this.#harness = harness;
		this.#settings = settings;
		this.#infos = infos;
		this.workplaces = workplaces;
		this.#placed = placed;
		this.#shapes = shapes;
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
		this.#botToolsets = new BotToolsets(harness, owners, platform.native, (id) => this.workplaces.at(String(id))?.kind ?? "missing");
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
		return this.#infos;
	}

	async apply(next: Settings): Promise<Applied> {
		const changed = changedKeys(withRotated(this.#settings), next);
		if (changed.some((key) => APPLY[key] === "restart")) return "needs_restart";
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
		const { models, infos, webSearch } = await platform.models(settings, () => runtimeRef?.settings.compactAt ?? settings.compactAt, options.onReport);
		const registry = createRegistry();
		let runtimeRef: AgentRuntime | undefined;
		const ask: McpHooks["ask"] = (callId, form, signal) => (runtimeRef ? runtimeRef.forms.ask(callId, form, signal) : Promise.resolve({ action: "cancel" }));
		const triggerHost: TriggerHost = {
			changed: () => void runtimeRef?.triggers.sync(),
			unattended: (id) => runtimeRef?.triggers.unattended(id) ?? false,
			notify: async (title, text, conversationId) => {
				const bot = (await runtimeRef?.bots())?.find((candidate) => candidate.id === conversationId);
				return (await options.notify?.(title, text, conversationId, bot && { name: bot.name, avatar: avatarOf(bot) })) ?? "off";
			},
		};
		const shapes = new Map<string, ContextShape>();
		const placed = new Map<string, Placed>();
		const clouds = connectClouds(settings, platform.rotated);
		const workplaces = new Workplaces(settings, clouds.minted, platform.phone, (id) => placed.get(id));
		const at = (id: string) => workplaces.at(id);
		const catalog = builtinExtensions({
			native: platform.native,
			assistant: createAssistant(platform.inApp, (id, shape) => void shapes.set(id, shape)),
			calendarAccess: settings.calendarAccess,
			...(settings.githubToken ? { githubToken: settings.githubToken } : {}),
			clouds: clouds.services,
			web: webSearch,
			triggers: triggerHost,
			memory: { changed: () => runtimeRef && runtimeRef.#publishMemory() },
			workplace: at,
			waitForJob: (id, job) => runtimeRef?.waitForJob(id, job),
			actsAsUser: (id) => (runtimeRef ? runtimeRef.#actsAsUser(id) : Promise.resolve(false)),
			permissions: platform.permissions,
			ask,
			userSaid: async (id) => (runtimeRef ? runtimeRef.#userSaid(id) : []),
			labelOf: (tool, extension, id) => labelOf(tool, extension, at(id)?.kind ?? "missing", catalog.owners, mcp),
		});
		for (const extension of catalog.extensions) registry.install(extension);
		const builtinTools: ReadonlySet<string> = new Set(catalog.owners.keys());
		const mcp: McpHub = new McpHub(platform, {
			install: (extension) => registry.install(extension),
			uninstall: (name) => registry.uninstall({ name }),
			revoke: (extension) => (runtimeRef ? runtimeRef.#revoke(extension) : Promise.resolve()),
			openUrl: (url) => options.openUrl?.(url) ?? Promise.reject(new Error("cannot open the browser here")),
			hostKey: (address) => pairedHosts(runtimeRef?.settings ?? settings).find((host) => host.address === address)?.key ?? "",
			builtinTools: () => builtinTools,
			ask,
		});
		const harness = await Harness.open(
			storage,
			{
				models: () => models,
				registry,
				settings: {
					retry: MODEL_RETRY,
					get extensions() {
						return registry
							.snapshot()
							.installed()
							.filter((extension) => !isMcpExtension(extension.name));
					},
				},
				onReport: (report) => options.onReport?.(messageOf(report.error)),
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
			infos,
			workplaces,
			placed,
			shapes,
			() => new Set(registry.snapshot().installed().map((extension) => extension.name)),
			catalog.owners,
			mcp,
			new Forms(harness, {
				unattended: triggerHost.unattended,
				waiting: async (form) => {
					if (!(await platform.inFront())) await triggerHost.notify(form.request.message, form.service, form.conversationId);
				},
			}),
			createJudge(models),
		);
		mcp.connectUncached();
		runtimeRef = runtime;
		if ((await runtime.bots()).length === 0) await runtime.createBot(DEFAULT_BOT);
		else await runtime.#publishBots();
		harness.resume();
		void runtime.triggers.sync().catch((error: unknown) => options.onReport?.(`自動化同步失敗：${messageOf(error)}`));
		void (async () => {
			for (const bot of (await runtime.#allBots()).filter((candidate) => candidate.removing)) {
				await orLogged(runtime.#finishRemoval(bot), "bot.finish_removal_failed", undefined, { bot: String(bot.id) });
			}
			await orLogged(runtime.#clearLeftFolders(), "bot.clear_left_folders_failed", undefined);
			const watching = await orLogged(runtime.triggers.watching(), "jobs.resume_failed", []);
			for (const { conversationId, agent } of watching) if (agent.startsWith("job:")) runtime.waitForJob(conversationId, agent);
		})();
		return runtime;
	}

	async #revoke(extension: string): Promise<void> {
		await this.#botToolsets.revoke(extension, (await this.bots()).map((bot) => bot.id));
	}

	async #actsAsUser(id: ConversationId): Promise<boolean> {
		const bot = (await this.bots()).find((candidate) => candidate.id === id);
		return bot !== undefined && !(await this.#botToolsets.off(bot)).includes("phone_as_user");
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
		return (await botsIn(this.#harness, context)).sort((a, b) => b.updatedAt - a.updatedAt);
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
		await this.#botToolsets.apply(bots.map((bot) => bot.id));
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
		const folder = uuidv7();
		const conversation = await this.#harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: this.#defaultAgent(),
				init: async (tx, id) => {
					const now = Date.now();
					(await tx.doc(BotIndex)).items.push({ id, name, job, folder, avatar, createdAt: now, updatedAt: now, off: [], rhythmOffer: NEW_BOT_OFFER });
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
		await this.#finishRemoval(bot);
	}

	async #finishRemoval(bot: Bot): Promise<void> {
		await Promise.all(
			this.workplaces.hosts().map((host) => orLogged(new HostCommands(host).run(stopOwnedJobs(String(bot.id))), "bot.stop_jobs_failed", undefined, { bot: bot.folder, host: host.name })),
		);
		await this.triggers.removeBot(bot.id);
		await (await this.#harness.conversation(bot.id, context))?.abort(context, { background: true });
		const phone = this.#platform.phone;
		if (phone) await orLogged(phone.removeFolder(bot.folder), "bot.remove_phone_folder_failed", undefined, { bot: bot.folder });
		const browser = this.#platform.browser;
		if (browser) await orLogged(browser.forget(String(bot.id)), "bot.remove_browser_failed", undefined, { bot: String(bot.id) });
		const reports = this.#platform.reports;
		if (reports) await orLogged(reports.forget(String(bot.id)), "bot.remove_reports_failed", undefined, { bot: String(bot.id) });
		await orLogged(deleteAttachments({ conversationId: String(bot.id) }), "bot.remove_attachments_failed", undefined, { bot: String(bot.id) });
		await this.#harness.commit(async (tx) => {
			const items = (await tx.doc(BotIndex)).items;
			const at = items.findIndex((candidate) => candidate.id === bot.id);
			if (at >= 0) items.splice(at, 1);
			await tx.retireDoc(BotMemoryDoc, bot.id);
			await tx.retireDoc(FormsDoc, bot.id);
			await tx.retireDoc(ResultsDoc, bot.id);
			(await tx.doc(LeftFolders)).items.push(...this.workplaces.containers().map(({ key }) => ({ folder: bot.folder, computer: key })));
		}, context);
		await this.#publishBots();
		void orLogged(this.#clearLeftFolders(), "bot.clear_left_folders_failed", undefined);
	}

	async #clearLeftFolders(): Promise<void> {
		const left = (await this.#harness.snapshot(LeftFolders, context))?.items ?? [];
		const containers = this.workplaces.containers();
		const cleared = new Set<string>();
		for (const computer of new Set(left.map((item) => item.computer))) {
			const sandbox = containers.find((candidate) => candidate.key === computer)?.sandbox;
			for (const { folder } of left.filter((item) => item.computer === computer)) {
				const removed = sandbox ? await orLogged(sandbox.remove(folder).then(() => true), "bot.remove_container_folder_failed", false, { bot: folder, computer }) : true;
				if (!removed) break;
				cleared.add(`${computer}\n${folder}`);
			}
		}
		if (cleared.size === 0) return;
		await this.#harness.commit(async (tx) => {
			const items = (await tx.doc(LeftFolders)).items;
			const kept = items.filter((item) => !cleared.has(`${item.computer}\n${item.folder}`));
			items.splice(0, items.length, ...kept);
		}, context);
	}

	waitForJob(id: ConversationId, job: string): void {
		const key = `${String(id)}\n${job}`;
		const on = this.#jobOn(id, job);
		if (this.#waiting.has(key) || !on) return;
		this.#waiting.add(key);
		const waited = on.commands.run(waitJob(on.jobId)).then(async (ended) => {
			if (ended.code === 0) await this.triggers.checkWatch(id, job);
		});
		void orLogged(waited, "jobs.wait_failed", undefined, { job }).finally(() => this.#waiting.delete(key));
	}

	async peekJob(id: ConversationId, job: string): Promise<{ command: string; output: string } | undefined> {
		const on = this.#jobOn(id, job);
		if (!on) return undefined;
		const read = parseJob((await on.commands.run(readJob(on.jobId, PEEK_LINES))).stdout);
		return read.state === "missing" ? undefined : { command: read.output.command, output: read.output.text };
	}

	async stopJob(id: ConversationId, job: string): Promise<void> {
		const on = this.#jobOn(id, job);
		if (!on) return;
		const stopped = await on.commands.run(stopJob(on.jobId));
		if (stopped.code !== 0) throw new Error(stopped.stderr.trim() || `停不下來（exit ${stopped.code}）`);
		await this.triggers.stopWatching(id, job);
	}

	#jobOn(id: ConversationId, job: string): { commands: HostCommands; jobId: string } | undefined {
		const place = this.workplaces.at(String(id));
		const jobId = job.slice("job:".length);
		return place?.kind === "computer" && JOB_ID.test(jobId) ? { commands: new HostCommands(place.host), jobId } : undefined;
	}

	async peekAgent(id: ConversationId, agent: string): Promise<Reading> {
		const place = this.workplaces.at(String(id));
		const at = placeOf(agent);
		if (place?.kind !== "computer" || !at) return { ok: false, problem: `${agent} is not on a computer` };
		return reading(at, (await new HostCommands(place.host).run(readCommand(at, PEEK_LINES))).stdout);
	}

	subscribeActivity(listener: (busy: ReadonlySet<ConversationId>) => void): () => void {
		const emit = (graph: TaskGraph) =>
			listener(new Set(Object.values(graph.tasks).flatMap((task) => (task.background ? [] : [task.conversationId]))));
		const watching = this.#harness.watchTaskGraph(context).then((watch) => {
			emit(watch.value);
			watch.start(async (call) => {
				if (call.kind === "value") emit(call.value);
			});
			return watch;
		});
		return () => void watching.then((watch) => watch.stop());
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
		const view = await activeView(conversation);
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
					const spoke = content.length > 0;
					const text = contentText(content);
					await this.#harness.commit(async (tx) => {
						const speaker = spoke ? (await tx.doc(BotIndex)).items.find((candidate) => candidate.id === id) : undefined;
						if (speaker) userSpoke(speaker, Date.now());
						const doc = await tx.doc(OutsideDoc, id);
						Object.assign(doc, said(doc, text));
					}, context);
					try {
						await conversation.submit({ type: "input", content, whenBusy }, context);
					} finally {
						if (spoke) await this.#publishBots();
					}
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
			results: async () => [...((await this.#harness.snapshot(ResultsDoc, id, context))?.cards ?? [])],
			dispose: () => void orLogged(view.dispose(), "conversation.unwatch_failed", undefined),
		};
	}

	async #userSaid(id: ConversationId): Promise<readonly string[]> {
		const conversation = await this.#harness.conversation(id, context);
		if (!conversation) return [];
		const { entries } = await conversation.context(context);
		return entries
			.filter((entry) => entry.kind === "pi.user")
			.map(entryText)
			.filter((said) => !said.includes("[trigger]"))
			.slice(-USER_MESSAGES);
	}

	contextShape(id: ConversationId): ContextShape | undefined {
		return this.#shapes.get(String(id));
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

	#services(): ServiceToolset[] {
		return this.mcp.servers.map((server) => ({ kind: "service" as const, id: extensionName(server), label: server.name, hint: hostOf(server.url), extension: extensionName(server) }));
	}

	async toolsets(id: ConversationId): Promise<ToolsetState[]> {
		const bot = (await this.bots()).find((candidate) => candidate.id === id);
		const off = bot ? await this.#botToolsets.off(bot) : [];
		const services = await this.#botToolsets.services(id);
		const installed = this.#installed();
		const place = this.workplaces.at(String(id))?.kind ?? "missing";
		const owned = [...this.#owners.values()];
		const builtins = TOOLSETS.filter((toolset) => usable(toolset, this.#platform.native) && owned.some((groups) => groups !== "always" && groups.some((group) => group === toolset.id)));
		return [
			...builtins.map((toolset) => ({ ...toolset, available: isAt(toolset, place), enabled: !off.includes(toolset.id) })),
			...this.#services().map((toolset) => ({ ...toolset, available: installed.has(toolset.extension), enabled: services.includes(toolset.extension) })),
		];
	}

	setToolset(id: ConversationId, toolset: string, enabled: boolean): Promise<void> {
		const service = this.#services().find((candidate) => candidate.id === toolset);
		if (service) return this.#botToolsets.setService(id, service.extension, enabled);
		if (!TOOLSETS.some((candidate) => candidate.id === toolset)) return Promise.reject(new Error(`${toolset} is not available`));
		return this.#botToolsets.setGroup(id, toolset, enabled);
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

	#publishMemory(): void {
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
		this.#publishMemory();
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
