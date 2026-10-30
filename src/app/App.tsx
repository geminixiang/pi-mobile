import type { ConversationView } from "@earendil-works/pi-durable";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import type { Bot } from "../agent/bots.ts";
import { inboxFile } from "../scanner-plugin.ts";
import { AgentRuntime, type ConversationController, type ConversationId } from "../agent/runtime.ts";
import { isConfigured, loadSettings, type Settings, saveSettings } from "../settings.ts";
import { openAppStorage } from "./storage.ts";
import { BotAvatar } from "./BotAvatar.tsx";
import { BotSheet, type BotEdit } from "./BotSheet.tsx";
import { Chat, isBusy, type Notice, type SharedKind } from "./Chat.tsx";
import { BotPanel } from "./BotPanel.tsx";
import { Dialog, type DialogRequest } from "./Dialog.tsx";
import { Drawer } from "./Drawer.tsx";
import { AzureMark, ChevronDownIcon, CloudflareMark, FolderIcon, GitHubMark, GlobeIcon, GoogleCloudMark, MoreIcon, TerminalIcon } from "./icons.tsx";
import { BrowserView } from "./BrowserView.tsx";
import { browserState } from "../agent/tools/browser.ts";
import { Browser } from "../plugins/browser.ts";
import { ModelSheet, shortModelName, thinkingLabel } from "./ModelSheet.tsx";
import { PiMark } from "./PiMark.tsx";
import { Skeleton, TranscriptSkeleton } from "./Skeleton.tsx";
import { usePrefs } from "./prefs.ts";
import { SettingsView } from "./Settings.tsx";
import { MemoryView } from "./MemoryView.tsx";
import { Layer, Sheet } from "./Sheet.tsx";
import { OpenFileContext } from "./openFile.ts";
import { WorkspaceView, type WorkspaceTab } from "./WorkspaceView.tsx";
import { log } from "../log.ts";
import { agentOf } from "./docs.ts";
import { inForeground, notifyAway, setWorking } from "./keepAlive.ts";
import { native } from "../native.ts";
import { listenForOpenLinks, processTriggerEvents, type SharedItem } from "./triggers.ts";
import type { Trigger } from "../agent/triggers.ts";
import { Triggers } from "../plugins/triggers.ts";
import { System } from "../plugins/system.ts";
import { contextPercent, contextTokens } from "./usage.ts";
import { SideSwipe } from "./SidePanel.tsx";
import { sweepBotData } from "./bot-data.ts";
import { clearDraft } from "./drafts.ts";
import { messageOf, orLogged } from "../promise.ts";
import { startModelList } from "../agent/available-models.ts";
import { capacitorPlatform } from "../agent/platform.ts";

const LAST_BOT_KEY = "pi-mobile.lastBot";

const botWithId = (items: readonly Bot[], id: string | null) => items.find((bot) => String(bot.id) === id);
const lastBot = (items: readonly Bot[]) => botWithId(items, localStorage.getItem(LAST_BOT_KEY));
const REOPEN_AFTER_MS = 10_000;
const MAX_NOTICES = 3;

const sharedKind = (files: readonly File[]): SharedKind =>
	files.length === 0 ? "text" : files.every((file) => file.type.startsWith("image/")) ? "image" : "file";

type Overlay = "drawer" | "panel" | "model" | "settings" | "botMemory" | "workspace" | "browser" | undefined;

const SETTINGS_APPLY_MS = 800;

export function App() {
	const [settings, setSettings] = useState<Settings>();
	const [runtime, setRuntime] = useState<AgentRuntime>();
	const [openError, setOpenError] = useState("");
	const [bots, setBots] = useState<Bot[]>([]);
	const [controller, setController] = useState<ConversationController>();
	const [view, setView] = useState<ConversationView>();
	const [pending, setPending] = useState<{ draft?: string; files?: readonly File[]; shared?: SharedKind }>({});
	const [overlay, setOverlay] = useState<Overlay>();
	const [dialog, setDialog] = useState<{ request: DialogRequest; resolve: (sure: boolean) => void }>();
	const [focusKey, setFocusKey] = useState(0);
	const [prefs, updatePrefs] = usePrefs();
	const [botEdit, setBotEdit] = useState<BotEdit>();
	const [memoryBot, setMemoryBot] = useState<Bot>();
	const [sharing, setSharing] = useState<{ draft: string; files: File[] }>();
	const [chatKey, setChatKey] = useState(0);
	const [workspaceStart, setWorkspaceStart] = useState<{ tab: WorkspaceTab; file?: string }>({ tab: "files" });
	const [browser, setBrowser] = useState<{ used: ReadonlySet<string>; handovers: readonly { bot: string; reason: string }[] }>({ used: new Set(), handovers: [] });
	useEffect(() => browserState.subscribe(setBrowser), []);
	const currentBot = controller ? String(controller.id) : undefined;
	const handover = browser.handovers.find((item) => item.bot === currentBot);
	const handoverReason = handover?.reason;
	useEffect(() => {
		if (handoverReason !== undefined) setOverlay("browser");
	}, [handoverReason]);
	const openWorkspace = useCallback((start: { tab: WorkspaceTab; file?: string }) => {
		setWorkspaceStart(start);
		setOverlay("workspace");
	}, []);
	const openFile = useCallback((file: string) => openWorkspace({ tab: "files", file }), [openWorkspace]);
	const close = useCallback(() => setOverlay(undefined), []);
	const settingsDraft = useRef<{ settings: Settings; changed: boolean }>(undefined);
	const applyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const applyRef = useRef<(draft: { settings: Settings; changed: boolean } | undefined) => Promise<void>>(undefined);
	const onSettingsDraft = useCallback((next: Settings, changed: boolean) => {
		settingsDraft.current = { settings: next, changed };
		clearTimeout(applyTimer.current);
		if (changed) applyTimer.current = setTimeout(() => void applyRef.current?.(settingsDraft.current), SETTINGS_APPLY_MS);
	}, []);

	const [notices, setNotices] = useState<readonly Notice[]>([]);
	const lastNotice = useRef(0);
	const notify = useCallback((message: string) => {
		log.warn("app.notice", { message });
		const id = ++lastNotice.current;
		setNotices((current) => [...current.filter((notice) => notice.text !== message), { id, text: message }].slice(-MAX_NOTICES));
	}, []);
	const dismissNotices = useCallback((ids: readonly number[]) => setNotices((current) => current.filter((notice) => !ids.includes(notice.id))), []);
	const fail = useCallback((error: unknown) => notify(messageOf(error)), [notify]);

	const ask = useCallback((request: DialogRequest) => new Promise<boolean>((resolve) => setDialog({ request, resolve })), []);

	const live = useRef({ settings, runtime, controller });
	live.current = { settings, runtime, controller };
	const dropConversation = useCallback(() => {
		live.current.controller?.dispose();
		setController(undefined);
		setView(undefined);
	}, []);

	const start = useCallback(
		async (next: Settings) => {
			try {
				const modelIds = startModelList(next);
				const { storage, isNewDatabase } = await openAppStorage();
				if (isNewDatabase) {
					await sweepBotData(async () => []);
					localStorage.removeItem(LAST_BOT_KEY);
				}
				const opened = await AgentRuntime.open(storage, next, capacitorPlatform(modelIds), {
					onReport: notify,
					openUrl: (url) => System.openExternal({ url }),
					notify: async (title, text, conversationId, avatar) => {
						if ((inForeground() && live.current.controller?.id === conversationId) || !native.implements(Triggers.notify)) return false;
						await Triggers.notify({ title, text, conversation: String(conversationId), ...(avatar ? { avatar } : {}) });
						return true;
					},
				});
				setRuntime(opened);
				const openedAt = Date.now();
				void opened.closed.then(async (end) => {
					if (end.reason !== "failed") return;
					log.warn("runtime.failed", { error: messageOf(end.error) });
					if (Date.now() - openedAt < REOPEN_AFTER_MS) {
						setOpenError(`資料出錯，請重開 pi：${messageOf(end.error)}`);
						return;
					}
					dropConversation();
					await orLogged(opened.close(), "runtime.close_failed", undefined);
					setRuntime(undefined);
					await start(live.current.settings ?? next);
				});
				setTimeout(() => void sweepBotData(async () => (await opened.bots()).map((bot) => ({ id: String(bot.id), folder: bot.folder }))), 10_000);
				setOpenError("");
			} catch (error) {
				setOpenError(`開啟失敗：${messageOf(error)}`);
			}
		},
		[notify, dropConversation],
	);

	useEffect(() => {
		void loadSettings().then((loaded) => {
			setSettings(loaded);
			if (isConfigured(loaded)) void start(loaded);
		});
	}, [start]);

	useEffect(() => (runtime ? runtime.subscribeBots(setBots) : undefined), [runtime]);
	const [automations, setAutomations] = useState<readonly Trigger[]>([]);
	useEffect(() => (runtime ? runtime.triggers.subscribe((state) => setAutomations(state.items)) : undefined), [runtime]);

	const [busyIds, setBusyIds] = useState<ReadonlySet<ConversationId>>(new Set());
	const previousBusy = useRef<ReadonlySet<ConversationId>>(new Set());
	useEffect(() => (runtime ? runtime.subscribeActivity(setBusyIds) : undefined), [runtime]);
	useEffect(() => {
		const title = (id: ConversationId) => bots.find((bot) => bot.id === id)?.name ?? "Bot";
		setWorking([...busyIds].map(title));
		const finished = [...previousBusy.current].filter((id) => !busyIds.has(id) && !runtime?.triggers.takeStarted(id));
		if (finished.length > 0) notifyAway("pi 完成了", finished.map(title).join("、"));
		previousBusy.current = busyIds;
	}, [busyIds, bots, runtime]);

	const openConversation = useCallback(
		async (id: ConversationId, draft?: string, files?: readonly File[], shared?: SharedKind, keepOverlay?: boolean) => {
			if (!runtime) return;
			if (!keepOverlay) setOverlay(undefined);
			if (id === controller?.id && draft === undefined) return;
			controller?.dispose();
			const next = await runtime.openConversation(id);
			localStorage.setItem(LAST_BOT_KEY, String(id));
			setChatKey((key) => key + 1);
			setPending({ draft, files, shared });
			setView(undefined);
			setController(next);
		},
		[runtime, controller],
	);

	useEffect(() => {
		if (!runtime || !controller) return;
		if (bots.some((bot) => bot.id === controller.id)) return;
		let live = true;
		void runtime.bots().then((items) => {
			if (!live || items.some((bot) => bot.id === controller.id)) return;
			dropConversation();
		});
		return () => {
			live = false;
		};
	}, [runtime, controller, bots, dropConversation]);

	useEffect(() => {
		if (!runtime || controller) return;
		void runtime.bots().then((items) => {
			const target = lastBot(items) ?? items[0];
			if (target) void openConversation(target.id, undefined, undefined, undefined, true);
		});
	}, [runtime, controller, openConversation]);

	const openLatest = useEffectEvent(openConversation);
	useEffect(() => {
		if (!runtime) return;
		const onShare = async (item: SharedItem) => {
			const files = await Promise.all((item.files ?? []).map((file) => inboxFile(file.path, file.name, file.mimeType)));
			const draft = [item.subject, item.text].filter((part) => part && part.trim()).join("\n");
			if (!draft && files.length === 0) {
				notify("沒有讀到分享的內容。");
				return;
			}
			const items = await runtime.bots();
			const kind = item.source === "assist" ? "screen" : sharedKind(files);
			const last = lastBot(items) ?? (items.length === 1 ? items[0] : undefined);
			if (last && (kind === "screen" || items.length === 1)) await openLatest(last.id, item.source === "assist" ? "" : draft, files, kind);
			else setSharing({ draft, files });
		};
		const stopEvents = processTriggerEvents(runtime, { onShare, onOpened: (id) => void openLatest(id) });
		const stopLinks = listenForOpenLinks((conversation) => {
			void runtime.bots().then((items) => {
				const target = botWithId(items, conversation);
				if (target) void openLatest(target.id);
			});
		});
		return () => {
			stopEvents();
			stopLinks();
		};
	}, [runtime, notify]);

	useEffect(() => controller?.subscribe(setView), [controller]);

	useEffect(() => {
		Object.assign(globalThis, { piRuntime: runtime, piController: controller });
	}, [runtime, controller]);

	const controllerId = controller?.id;
	const loadWorkspace = useCallback(
		() => (runtime && controllerId !== undefined ? runtime.workspace(controllerId) : Promise.resolve(undefined)),
		[runtime, controllerId],
	);

	const applying = useRef<Promise<void>>(Promise.resolve());
	const card = useRef<HTMLDivElement>(null);

	const side = overlay === "drawer" ? "left" : overlay === "panel" ? "right" : undefined;
	const sideBlocked = (overlay !== undefined && side === undefined) || dialog !== undefined || botEdit !== undefined || sharing !== undefined;

	const splash = <Skeleton />;
	const dialogView = (
		<Dialog
			request={dialog?.request}
			onAnswer={(sure) => {
				dialog?.resolve(sure);
				setDialog(undefined);
			}}
		/>
	);
	if (!settings) return splash;

	const applySettings = async (next: Settings, blank: boolean) => {
		const current = live.current.runtime;
		if (current && (await current.apply(next)) === "in_place") return;
		dropConversation();
		await current?.close();
		if (blank) setRuntime(undefined);
		await start(next);
	};
	const saveAndRestart = async (edited: Settings) => {
		const next = await saveSettings(edited);
		setSettings(next);
		if (!isConfigured(next)) return;
		setOverlay(undefined);
		await applySettings(next, true);
	};
	applyRef.current = (draft) => {
		if (!draft?.changed || !isConfigured(draft.settings)) return Promise.resolve();
		draft.changed = false;
		applying.current = applying.current
			.then(async () => {
				const next = await saveSettings(draft.settings);
				setSettings(next);
				await applySettings(next, false);
			})
			.catch(fail);
		return applying.current;
	};
	function leaveSettings() {
		clearTimeout(applyTimer.current);
		const draft = settingsDraft.current;
		settingsDraft.current = undefined;
		if (draft?.changed && !isConfigured(draft.settings)) {
			void ask({ title: "變更沒有儲存", body: "沒有可用的模型供應商。離開會放棄這次的變更。", confirm: "放棄變更", danger: true }).then((sure) => {
				if (sure) close();
				else settingsDraft.current = draft;
			});
			return;
		}
		if (draft?.changed) void applyRef.current?.(draft);
		close();
	}

	if (!runtime) {
		if (isConfigured(settings) && !openError) return splash;
		return (
			<div className="app">
				<SettingsView initial={settings} status={openError} onSave={saveAndRestart} />
				{dialogView}
			</div>
		);
	}
	const place = controller ? runtime.workplaces.at(String(controller.id)) : undefined;
	const onSandbox = place?.kind === "computer";
	const hasFolder = place?.kind === "computer" || place?.kind === "phone";

	const agent = agentOf(view);
	const modelId = agent?.model?.modelId ?? "";
	const modelProvider = agent?.model?.provider ?? "";
	const thinking = agent?.thinkingLevel ?? "";
	const model = runtime.models.find((candidate) => candidate.provider === modelProvider && candidate.id === modelId);
	const current = bots.find((bot) => bot.id === controller?.id);
	const used = contextTokens(view);
	const contextWindow = model?.contextWindow ?? 0;
	const busy = isBusy(view);
	const openMemory = (bot: Bot) => {
		setMemoryBot(bot);
		setOverlay("botMemory");
	};

	return (
		<div
			ref={card}
			data-thinking={thinking || "off"}
			className="app"
		>
			<header className="bar">
				<button type="button" className="icon-button brand-button" onClick={() => setOverlay("drawer")} aria-label="Bot 列表">
					<PiMark size={18} live={busy} />
				</button>
				<button type="button" className="bar-center" onClick={() => setOverlay("model")} aria-label="模型與思考強度">
					<span className="bar-title">
						{current ? <BotAvatar bot={current} size={18} /> : null}
						{current?.name ?? ""}
					</span>
					<span className="bar-model">
						{shortModelName(model?.name ?? modelId)}
						{thinking && thinking !== "off" ? ` · 思考${thinkingLabel(thinking)}` : ""}
						<ChevronDownIcon />
					</span>
				</button>
				{currentBot && (browser.used.has(currentBot) || handover) ? (
					<button type="button" className="icon-button" aria-label="瀏覽器" onClick={() => setOverlay("browser")}>
						<GlobeIcon />
					</button>
				) : null}
				{hasFolder ? (
					<button type="button" className="icon-button" aria-label="資料夾" onClick={() => openWorkspace({ tab: "files" })}>
						<FolderIcon />
					</button>
				) : null}
				<button type="button" className="icon-button" aria-label="Bot 資訊" onClick={() => setOverlay("panel")}>
					<MoreIcon />
				</button>
				<div className="meter" aria-hidden="true">
					<i style={{ width: `${contextPercent(used, contextWindow)}%` }} />
				</div>
			</header>

			<SideSwipe
				card={card}
				open={side}
				disabled={sideBlocked}
				onChange={(next) => setOverlay(next === "left" ? "drawer" : next === "right" ? "panel" : undefined)}
				left={
					<Drawer
						open={overlay === "drawer"}
						busy={busy}
						bots={bots}
						automations={automations}
						currentId={controller?.id}
						status={[
							{ label: "GitHub", icon: <GitHubMark />, on: Boolean(settings.githubToken) },
							{ label: "電腦", icon: <TerminalIcon size={17} />, on: runtime.workplaces.any },
							{ label: "Google Cloud", icon: <GoogleCloudMark />, on: Boolean(settings.gcloudCredential) },
							{ label: "Cloudflare", icon: <CloudflareMark />, on: Boolean(settings.cloudflareCredential) },
							{ label: "Azure", icon: <AzureMark />, on: Boolean(settings.azureCredential) },
						]}
						onOpen={(id) => void openConversation(id)}
						onCreate={() => setBotEdit({ kind: "create" })}
						running={busyIds}
						onEdit={(bot) => setBotEdit({ kind: "edit", bot })}
						onSettings={() => setOverlay("settings")}
						onClose={close}
					/>
				}
				right={
					<BotPanel
						open={overlay === "panel"}
						bot={current}
						runtime={runtime}
						view={view}
						context={{ used, window: contextWindow }}
						compactAt={settings.compactAt}
						prefs={prefs}
						onPrefs={updatePrefs}
						onClose={close}
						actions={{
							edit: () => {
								if (current) setBotEdit({ kind: "edit", bot: current });
							},
							memory: () => {
								if (current) openMemory(current);
							},
							compact: () => (controller ? controller.compact() : Promise.resolve(false)),
							reset: async () => {
								if (!controller) return;
								const sure = await ask({
									title: "新的上下文",
									body: "模型將看不到這之前的訊息。紀錄仍會留在畫面上。",
									confirm: "開始新的上下文",
								});
								if (sure) await controller.reset().catch(fail);
							},
							emptyFolder: controller && place?.kind === "computer" && !place.sandbox.direct
								? async () => {
										const sure = await ask({
											title: "清空資料夾",
											body: `${current?.name ?? "這個 Bot"} 在容器裡的資料夾和所有檔案都會刪除。其他 Bot 的資料夾不受影響。`,
											confirm: "清空",
											danger: true,
										});
										if (!sure) return false;
										await runtime.resetSandbox(controller.id);
										return true;
									}
								: undefined,
						}}
					/>
				}
			>
				{controller ? (
					<OpenFileContext.Provider value={hasFolder ? openFile : undefined}>
					<Chat
						key={`${String(controller.id)}-${chatKey}`}
						controller={controller}
						prefs={prefs}
						sandbox={onSandbox}
						view={view}
						initialDraft={pending.draft}
						initialFiles={pending.files}
						shared={pending.shared}
						focusKey={focusKey}
						notices={notices}
						onDismissNotices={dismissNotices}
						onError={notify}
						contextShare={contextWindow > 0 ? used / contextWindow : 0}
					/>
					</OpenFileContext.Provider>
				) : (
					<div className="chat">
					<TranscriptSkeleton />
				</div>
				)}
			</SideSwipe>

			<ModelSheet
				open={overlay === "model"}
				models={runtime.models}
				current={{ provider: modelProvider, id: modelId }}
				thinking={thinking}
				onClose={close}
				onChange={async ({ model: nextModel, thinking: nextThinking }) => {
					if (!controller) return;
					if (nextModel) await controller.setModel(nextModel.provider, nextModel.id).catch(fail);
					if (nextThinking) await controller.setThinking(nextThinking).catch(fail);
					if (nextModel) close();
				}}
			/>

			<BotSheet
				edit={botEdit}
				canDelete={bots.length > 1}
				bots={bots}
				onClose={() => setBotEdit(undefined)}
				onError={notify}
				onSave={async (change) => {
					try {
						if (botEdit?.kind === "edit") {
							await runtime.updateBot(botEdit.bot.id, change);
							setBotEdit(undefined);
						} else {
							const id = await runtime.createBot(change);
							setBotEdit(undefined);
							await openConversation(id);
							setFocusKey((key) => key + 1);
						}
					} catch (error) {
						fail(error);
					}
				}}
				onMemory={(bot) => {
					setBotEdit(undefined);
					openMemory(bot);
				}}
				onDelete={async (bot) => {
					setBotEdit(undefined);
					const sure = await ask({
						title: `刪除 ${bot.name}`,
						body: "它的記憶、自動化、附件和資料夾都會刪除，無法復原。對話紀錄不再顯示，但還留在手機的資料庫裡。",
						confirm: "刪除",
						danger: true,
					});
					if (!sure) return;
					try {
						await runtime.removeBot(bot.id);
						if (native.implements(Browser.forget)) await Browser.forget({ bot: String(bot.id) });
						browserState.forget(String(bot.id));
						await orLogged(clearDraft(String(bot.id)), "drafts.clear_failed", undefined);
						if (bot.id === controller?.id) dropConversation();
					} catch (error) {
						fail(error);
					}
				}}
			/>

			<Sheet open={Boolean(sharing)} title="要交給哪個 Bot？" onClose={() => setSharing(undefined)}>
				<div className="menu">
					{bots.map((bot) => (
						<button
							type="button"
							key={String(bot.id)}
							onClick={() => {
								const item = sharing;
								setSharing(undefined);
								if (item) void openConversation(bot.id, item.draft, item.files, sharedKind(item.files));
							}}
						>
							<BotAvatar bot={bot} size={32} />
							<span className="menu-text">
								{bot.name}
								{bot.job.trim() ? <span className="menu-hint">{bot.job.split("\n")[0]}</span> : null}
							</span>
						</button>
					))}
				</div>
			</Sheet>

			<WorkspaceView open={overlay === "workspace"} load={loadWorkspace} initial={workspaceStart} onClose={close} />

			<BrowserView
				open={overlay === "browser"}
				bot={currentBot}
				reason={handover?.reason}
				onHandBack={() => {
					if (currentBot) browserState.handBack(currentBot);
				}}
				onClose={close}
			/>

			<Layer open={overlay === "botMemory" && Boolean(memoryBot)} kind="page" onClose={close} label="Bot 的記憶">
				{memoryBot ? (
					<MemoryView runtime={runtime} scope={{ kind: "bot", id: memoryBot.id }} botName={memoryBot.name} onClose={close} onError={notify} />
				) : null}
			</Layer>

			<Layer open={overlay === "settings"} kind="page" onClose={leaveSettings} label="設定">
				<SettingsView initial={settings} runtime={runtime} onCancel={leaveSettings} onDraft={onSettingsDraft} onSave={saveAndRestart} />
			</Layer>

			{dialogView}

		</div>
	);
}
