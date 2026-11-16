import { avatarOf, type Bot } from "../agent/bots.ts";
import { startModelList } from "../agent/available-models.ts";
import { capacitorPlatform, capacitorStorage } from "../agent/platform.ts";
import { AgentRuntime, type ConversationController, type ConversationId } from "../agent/runtime.ts";
import { away, inForeground, setWorking, stayAwakeFor } from "../keepAlive.ts";
import { log } from "../log.ts";
import { native } from "../native.ts";
import { KeepAlive } from "../plugins/keep-alive.ts";
import { System } from "../plugins/system.ts";
import { messageOf, orLogged } from "../promise.ts";
import { inboxFile } from "../scanner-plugin.ts";
import { isConfigured, type Settings, SettingsStore } from "../settings.ts";
import { after, afterPaint, type Cancel } from "../time.ts";
import { listenForOpenLinks, processTriggerEvents, type SharedItem } from "../triggers/events.ts";
import { Triggers } from "../triggers/plugin.ts";
import { onResume } from "../ui/resume.ts";
import { sweepBotData } from "./bot-data.ts";
import type { Notice, SharedKind } from "./Chat.tsx";
import { loadDraftText, saveDraftText } from "./drafts.ts";
import { openAppStorage } from "./storage.ts";

const LAST_BOT_KEY = "pi-mobile.lastBot";
const REOPEN_AFTER_MS = 10_000;
const SWEEP_AFTER_MS = 10_000;
const MAX_NOTICES = 3;

type Overlay = "drawer" | "panel" | "model" | "settings" | "botMemory" | "workspace" | undefined;

type Opening = { draft?: string; files?: readonly File[]; shared?: SharedKind; focus?: boolean; keepOverlay?: boolean };

type Session = {
	settings: Settings | undefined;
	runtime: AgentRuntime | undefined;
	openError: string;
	controller: ConversationController | undefined;
	opening: ConversationId | undefined;
	chatKey: number;
	pending: { files?: readonly File[]; shared?: SharedKind; focus: boolean };
	overlay: Overlay;
	sharing: { draft: string; files: File[] } | undefined;
	openItem: string | undefined;
	notices: readonly Notice[];
};

const settingsStore = new SettingsStore(capacitorStorage);
const watchers = new Set<() => void>();

let state: Session = {
	settings: undefined,
	runtime: undefined,
	openError: "",
	controller: undefined,
	opening: undefined,
	chatKey: 0,
	pending: { focus: false },
	overlay: undefined,
	sharing: undefined,
	openItem: undefined,
	notices: [],
};
let noticed = 0;
let closing: Cancel | undefined;

function set(change: Partial<Session>): void {
	state = { ...state, ...change };
	// why: the device and perf scripts (test/device, test/perf) drive the app through these two globals
	Object.assign(globalThis, { piRuntime: state.runtime, piController: state.controller });
	for (const changed of watchers) changed();
}

export const session = () => state;

export function watchSession(changed: () => void): Cancel {
	watchers.add(changed);
	return () => void watchers.delete(changed);
}

export const sharedKind = (files: readonly File[]): SharedKind => (files.length === 0 ? "text" : files.every((file) => file.type.startsWith("image/")) ? "image" : "file");

const botWithId = (items: readonly Bot[], id: string | null) => items.find((bot) => String(bot.id) === id);
const lastBot = (items: readonly Bot[]) => botWithId(items, localStorage.getItem(LAST_BOT_KEY));

export function notify(message: string): void {
	log.warn("app.notice", { message });
	noticed += 1;
	set({ notices: [...state.notices.filter((notice) => notice.text !== message), { id: noticed, text: message }].slice(-MAX_NOTICES) });
}

export function dismissNotices(ids: readonly number[]): void {
	set({ notices: state.notices.filter((notice) => !ids.includes(notice.id)) });
}

export function show(overlay: Overlay): void {
	if (overlay !== state.overlay) set({ overlay });
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

export async function saveSettings(edited: Settings): Promise<Settings> {
	const settings = await settingsStore.save(edited);
	set({ settings });
	return settings;
}

export async function applySettings(next: Settings, blank: boolean): Promise<void> {
	const current = state.runtime;
	if (current && (await current.apply(next)) === "in_place") return;
	drop();
	await current?.close();
	if (blank) set({ runtime: undefined });
	await start(next);
}

export async function open(id: ConversationId, { draft, files, shared, focus, keepOverlay }: Opening = {}): Promise<void> {
	const { runtime, controller } = state;
	if (!runtime) return;
	if (!keepOverlay) show(undefined);
	if (id === controller?.id && draft === undefined) return;
	controller?.dispose();
	const next = await runtime.openConversation(id);
	localStorage.setItem(LAST_BOT_KEY, String(id));
	if (draft) saveDraftText(String(id), [loadDraftText(String(id)), draft].filter(Boolean).join("\n\n"));
	set({ controller: next, chatKey: state.chatKey + 1, pending: { files, shared, focus: Boolean(focus || draft) } });
	markSeen();
	void runtime.forms.load(id).catch((error: unknown) => notify(messageOf(error)));
}

export function choose(id: ConversationId): void {
	closing?.();
	set({ opening: id });
	if (id === state.controller?.id) return appeared(id);
	void open(id, { keepOverlay: true }).catch((error: unknown) => {
		set({ opening: undefined, overlay: undefined });
		throw error;
	});
}

export function appeared(id: ConversationId): void {
	if (state.opening !== id || state.controller?.id !== id) return;
	closing?.();
	closing = afterPaint(() => set({ opening: undefined, overlay: undefined }));
}

export function leave(id: ConversationId): void {
	if (state.controller?.id !== id) return;
	drop();
	void openLast();
}

function drop(): void {
	state.controller?.dispose();
	set({ controller: undefined });
}

async function openLast(): Promise<void> {
	const { runtime, controller } = state;
	if (!runtime || controller) return;
	const items = await runtime.bots();
	const target = lastBot(items) ?? items[0];
	if (target) await open(target.id, { keepOverlay: true });
}

function markSeen(): void {
	const id = state.controller?.id;
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
				if (state.controller?.id === conversationId && (await inForeground())) return "watching";
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
			await start(state.settings ?? next);
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
		processTriggerEvents(runtime, { onShare: share, onOpened: (id) => void open(id) }),
		listenForOpenLinks((conversation, item) => void follow(conversation, item)),
		after(SWEEP_AFTER_MS, () => void sweepBotData(async () => (await runtime.bots()).map((bot) => ({ id: String(bot.id), folder: bot.folder })))),
	];
	return () => {
		for (const stop of stops) stop();
	};
}

async function leaveIfGone(runtime: AgentRuntime, bots: readonly Bot[]): Promise<void> {
	const current = state.controller;
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
