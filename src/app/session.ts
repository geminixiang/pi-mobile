import { avatarOf, type Bot } from "../agent/bots.ts";
import { startModelList } from "../agent/available-models.ts";
import { capacitorPlatform, capacitorStorage } from "./capacitor.ts";
import type { ConversationView } from "@earendil-works/pi-durable";
import { AgentRuntime, type ConversationController, type ConversationId } from "../runtime/runtime.ts";
import { away, inForeground, setWorking, stayAwakeFor } from "../keepAlive.ts";
import { log } from "../log.ts";
import { native } from "../native.ts";
import { KeepAlive } from "../plugins/keep-alive.ts";
import { System } from "../plugins/system.ts";
import { messageOf, orLogged } from "../promise.ts";
import { questionStates } from "../interaction/answers.ts";
import { inboxFile } from "../scanner-plugin.ts";
import { isConfigured, type Settings, SettingsStore } from "../settings.ts";
import { after, afterPaint, type Cancel } from "../time.ts";
import { listenForOpenLinks, processTriggerEvents, type SharedItem } from "../triggers/events.ts";
import { Triggers } from "../triggers/plugin.ts";
import { onResume } from "../ui/resume.ts";
import { cell, type Source } from "../ui/subscribed.ts";
import { sweepBotData } from "./bot-data.ts";
import type { Notice, SharedKind } from "./chat/Chat.tsx";
import { loadDraftText, offerFiles, saveDraftText } from "./chat/drafts.ts";
import type { Place } from "./SidePanel.tsx";
import { openAppStorage } from "./storage.ts";

const LAST_BOT_KEY = "pi-mobile.lastBot";
const REOPEN_AFTER_MS = 10_000;
const SWEEP_AFTER_MS = 10_000;
const MAX_NOTICES = 3;
const SETTINGS_APPLY_MS = 800;

type Overlay = "drawer" | "panel" | "model" | "settings" | "botMemory" | "workspace" | undefined;

type Opening = { draft?: string; files?: readonly File[]; shared?: SharedKind; focus?: boolean; keepOverlay?: boolean };

type Session = {
	settings: Settings | undefined;
	runtime: AgentRuntime | undefined;
	openError: string;
	controller: ConversationController | undefined;
	view: ConversationView | undefined;
	asking: boolean;
	opening: ConversationId | undefined;
	chatKey: number;
	pending: { shared?: SharedKind; focus: boolean };
	overlay: Overlay;
	sharing: { draft: string; files: File[] } | undefined;
	openItem: string | undefined;
	notices: readonly Notice[];
};

const settingsStore = new SettingsStore(capacitorStorage);

type Draft = { settings: Settings; changed: boolean };

const drafting: { draft?: Draft; cancel?: Cancel; applying: Promise<void> } = { applying: Promise.resolve() };

const store = cell<Session>({
	settings: undefined,
	runtime: undefined,
	openError: "",
	controller: undefined,
	view: undefined,
	asking: false,
	opening: undefined,
	chatKey: 0,
	pending: { focus: false },
	overlay: undefined,
	sharing: undefined,
	openItem: undefined,
	notices: [],
});
let noticed = 0;
let closing: Cancel | undefined;
let stopView: Cancel | undefined;

function set(change: Partial<Session>): void {
	const state = store.set((current) => ({ ...current, ...change }));
	// why: the device and perf scripts (test/device, test/perf) drive the app through these two globals
	if ("runtime" in change || "controller" in change) Object.assign(globalThis, { piRuntime: state.runtime, piController: state.controller });
}

export const session = store.read;
export const watchSession = store.subscribe;

const placed = (panel: Overlay, page: Overlay): Source<Place> => ({ subscribe: watchSession, read: () => (session().overlay === page ? "deep" : session().overlay === panel ? "open" : "closed") });

export const leftPanel = placed("drawer", "settings");
export const rightPanel = placed("panel", "botMemory");
export const memoryPage: Source<boolean> = { subscribe: watchSession, read: () => session().overlay === "botMemory" };

export const sharedKind = (files: readonly File[]): SharedKind => (files.length === 0 ? "text" : files.every((file) => file.type.startsWith("image/")) ? "image" : "file");

const botWithId = (items: readonly Bot[], id: string | null) => items.find((bot) => String(bot.id) === id);
const lastBot = (items: readonly Bot[]) => botWithId(items, localStorage.getItem(LAST_BOT_KEY));

export function notify(message: string): void {
	log.warn("app.notice", { message });
	noticed += 1;
	set({ notices: [...session().notices.filter((notice) => notice.text !== message), { id: noticed, text: message }].slice(-MAX_NOTICES) });
}

export function dismissNotices(ids: readonly number[]): void {
	set({ notices: session().notices.filter((notice) => !ids.includes(notice.id)) });
}

export function show(overlay: Overlay): void {
	if (overlay !== session().overlay) set({ overlay });
}

export const stopSharing = () => set({ sharing: undefined });
export const closeItem = () => set({ openItem: undefined });

export function boot(): void {
	void settingsStore.load().then((loaded) => {
		set({ settings: loaded });
		if (isConfigured(loaded)) void start(loaded);
	});
	onResume(markSeen);
}

async function saveSettings(edited: Settings): Promise<Settings> {
	const settings = await settingsStore.save(edited);
	set({ settings });
	return settings;
}

export async function saveAndRestart(edited: Settings): Promise<void> {
	const next = await saveSettings(edited);
	if (!isConfigured(next)) return;
	show(undefined);
	await applySettings(next, true);
}

export function draftSettings(next: Settings, changed: boolean): void {
	drafting.draft = { settings: next, changed };
	drafting.cancel?.();
	if (changed) drafting.cancel = after(SETTINGS_APPLY_MS, () => void applyDraft(drafting.draft));
}

export function closeSettings(): { state: "closed" } | { state: "unsaved"; keep: () => void } {
	drafting.cancel?.();
	const draft = drafting.draft;
	drafting.draft = undefined;
	if (draft?.changed && !isConfigured(draft.settings)) return { state: "unsaved", keep: () => void (drafting.draft = draft) };
	void applyDraft(draft);
	return { state: "closed" };
}

function applyDraft(draft: Draft | undefined): Promise<void> {
	if (!draft?.changed || !isConfigured(draft.settings)) return Promise.resolve();
	draft.changed = false;
	drafting.applying = drafting.applying.then(async () => applySettings(await saveSettings(draft.settings), false)).catch((error: unknown) => notify(messageOf(error)));
	return drafting.applying;
}

async function applySettings(next: Settings, blank: boolean): Promise<void> {
	const current = session().runtime;
	if (current && (await current.apply(next)) === "in_place") return;
	drop();
	await current?.close();
	if (blank) set({ runtime: undefined });
	await start(next);
}

export async function open(id: ConversationId, { draft, files, shared, focus, keepOverlay }: Opening = {}): Promise<void> {
	const { runtime, controller } = session();
	if (!runtime) return;
	if (!keepOverlay) show(undefined);
	if (id === controller?.id && draft === undefined) return;
	controller?.dispose();
	const next = await runtime.openConversation(id);
	localStorage.setItem(LAST_BOT_KEY, String(id));
	if (draft) saveDraftText(String(id), [loadDraftText(String(id)), draft].filter(Boolean).join("\n\n"));
	if (files?.length) offerFiles(String(id), files);
	stopView?.();
	set({ controller: next, view: undefined, asking: false, chatKey: session().chatKey + 1, pending: { shared, focus: Boolean(focus || draft) } });
	stopView = next.subscribe((view) => session().controller === next && see(view));
	markSeen();
	void runtime.forms.load(id).catch((error: unknown) => notify(messageOf(error)));
}

export function choose(id: ConversationId): void {
	closing?.();
	set({ opening: id });
	const settle = () => set({ opening: undefined, overlay: undefined });
	void open(id, { keepOverlay: true }).then(
		() => {
			if (session().opening === id) closing = afterPaint(settle);
		},
		(error: unknown) => {
			settle();
			throw error;
		},
	);
}

export function leave(id: ConversationId): void {
	if (session().controller?.id !== id) return;
	drop();
	void openLast();
}

function see(view: ConversationView): void {
	const asking = view.entries === session().view?.entries ? session().asking : [...questionStates(view.entries).values()].some((asked) => asked.state === "open");
	set({ view, asking });
}

function drop(): void {
	stopView?.();
	session().controller?.dispose();
	set({ controller: undefined, view: undefined, asking: false });
}

async function openLast(): Promise<void> {
	const { runtime, controller } = session();
	if (!runtime || controller) return;
	const items = await runtime.bots();
	const target = lastBot(items) ?? items[0];
	if (target) await open(target.id, { keepOverlay: true });
}

function markSeen(): void {
	const id = session().controller?.id;
	if (id !== undefined && native.implements(Triggers.seen)) void Triggers.seen({ conversation: String(id) });
}

async function start(next: Settings): Promise<void> {
	try {
		const modelIds = startModelList(next);
		const { storage, isNewDatabase } = await openAppStorage();
		if (isNewDatabase) {
			await sweepBotData(async () => []);
			localStorage.removeItem(LAST_BOT_KEY);
		}
		const opened = await AgentRuntime.open(storage, next, capacitorPlatform(modelIds, settingsStore), {
			onReport: notify,
			openUrl: (url) => System.openExternal({ url }),
			notify: async (title, text, conversationId, bot) => {
				if (session().controller?.id === conversationId && (await inForeground())) return "watching";
				if (!native.implements(Triggers.notify)) return "off";
				const { shown } = await Triggers.notify({ title, text, conversation: String(conversationId), ...(bot ? { bot: bot.name, avatar: bot.avatar } : {}) });
				return shown ? "shown" : "off";
			},
		});
		const openedAt = Date.now();
		set({ runtime: opened, openError: "" });
		const stopServing = serve(opened);
		void opened.closed.then(async (end) => {
			stopServing();
			if (end.kind !== "failed") return;
			log.warn("runtime.failed", { error: messageOf(end.error) });
			if (Date.now() - openedAt < REOPEN_AFTER_MS) {
				set({ openError: `資料出錯，請重開 pi：${messageOf(end.error)}` });
				return;
			}
			drop();
			await orLogged(opened.close(), "runtime.close_failed", undefined);
			set({ runtime: undefined });
			await start(session().settings ?? next);
		});
		void openLast();
	} catch (error) {
		set({ openError: `開啟失敗：${messageOf(error)}` });
	}
}

function serve(runtime: AgentRuntime): Cancel {
	const share = async (item: SharedItem) => {
		const files = await Promise.all((item.files ?? []).map((file) => inboxFile(file.path, file.name, file.mimeType)));
		const draft = [item.subject, item.text].filter((part) => part && part.trim()).join("\n");
		if (!draft && files.length === 0) return notify("沒有讀到分享的內容。");
		const items = await runtime.bots();
		const kind = item.source === "assist" ? "screen" : sharedKind(files);
		const last = lastBot(items) ?? (items.length === 1 ? items[0] : undefined);
		if (last && (kind === "screen" || items.length === 1)) await open(last.id, { draft: item.source === "assist" ? "" : draft, files, shared: kind });
		else set({ sharing: { draft, files } });
	};
	const follow = async (conversation: string, item: string | undefined) => {
		const target = botWithId(await runtime.bots(), conversation);
		if (!target) return;
		await open(target.id);
		set({ openItem: item });
	};
	const stops = [
		reportActivity(runtime),
		runtime.subscribeBots((bots) => void leaveIfGone(runtime, bots)),
		processTriggerEvents(runtime.triggers, { onShare: share, onOpened: (id) => void open(id) }),
		listenForOpenLinks((conversation, item) => void follow(conversation, item)),
		after(SWEEP_AFTER_MS, () => void sweepBotData(async () => (await runtime.bots()).map((bot) => ({ id: String(bot.id), folder: bot.folder })))),
	];
	return () => {
		for (const stop of stops) stop();
	};
}

async function leaveIfGone(runtime: AgentRuntime, bots: readonly Bot[]): Promise<void> {
	const current = session().controller;
	if (!current || bots.some((bot) => bot.id === current.id)) return;
	const fresh = await runtime.bots();
	if (!fresh.some((bot) => bot.id === current.id)) leave(current.id);
}

type Seen = { bots: readonly Bot[]; busy: ReadonlySet<ConversationId> };

function reportActivity(runtime: AgentRuntime): Cancel {
	let seen: Seen = { bots: [], busy: new Set() };
	const tell = async (id: ConversationId) => {
		const bot = seen.bots.find((candidate) => candidate.id === id);
		const word = await runtime.triggers.lastWord(id);
		if (!bot || !word || !(await away())) return;
		if (!native.implements(Triggers.notify)) return KeepAlive.notify({ title: bot.name, text: word.headline });
		await Triggers.notify({ title: word.headline, text: word.text, done: !word.asking, conversation: String(id), bot: bot.name, avatar: avatarOf(bot) });
	};
	const see = (next: Seen) => {
		const ended = [...seen.busy].filter((id) => !next.busy.has(id)).map((id) => ({ id, report: runtime.triggers.finished(id) }));
		seen = next;
		for (const { report } of ended) if (report) stayAwakeFor(report);
		setWorking([...next.busy].map((id) => next.bots.find((bot) => bot.id === id)?.name ?? "Bot"));
		for (const { id, report } of ended) if (!report) void orLogged(tell(id), "keep_alive.notify_failed", undefined);
	};
	const stopBots = runtime.subscribeBots((bots) => see({ ...seen, bots }));
	const stopBusy = runtime.subscribeActivity((busy) => see({ ...seen, busy }));
	return () => {
		stopBots();
		stopBusy();
	};
}
