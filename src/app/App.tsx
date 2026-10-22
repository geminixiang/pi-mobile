import type { ConversationView } from "@earendil-works/pi-durable";
import { useCallback, useEffect, useRef, useState } from "react";
import { setConfirmListener } from "../agent/confirm.ts";
import type { Bot } from "../agent/bots.ts";
import { AgentRuntime, type ConversationController, type ConversationId } from "../agent/runtime.ts";
import { isConfigured, loadSettings, type Settings, saveSettings } from "../settings.ts";
import { openAppStorage, takeLegacyStorage } from "../storage.ts";
import { BotAvatar } from "./BotAvatar.tsx";
import { BotSheet, type BotEdit } from "./BotSheet.tsx";
import { Capacitor } from "@capacitor/core";
import { Chat, isBusy, type SharedKind } from "./Chat.tsx";
import { BotPanel } from "./BotPanel.tsx";
import { showToast } from "./Toasts.tsx";
import { type Ask, Dialog, type DialogRequest } from "./Dialog.tsx";
import { Drawer } from "./Drawer.tsx";
import { AzureMark, ChevronDownIcon, CloudflareMark, GitHubMark, GoogleCloudMark, MoreIcon, TerminalIcon } from "./icons.tsx";
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
import { inForeground, notifyAway, setWorking, showWaiting } from "./keepAlive.ts";
import { askByNotification, listenForOpenLinks, processTriggerEvents, type SharedItem } from "./triggers.ts";
import { TRIGGER_ENTRY, Triggers } from "../agent/triggers.ts";
import { listenForPairing, type Pairing } from "./pairing.ts";
import { System } from "../system-plugin.ts";
import { checkSandbox } from "../agent/checks.ts";
import { contextTokens, latestCacheHitRate, totalUsage } from "./usage.ts";
import { SideSwipe } from "./SidePanel.tsx";
import { sweepBotData } from "./bot-data.ts";
import { clearDraft } from "./drafts.ts";

const LAST_BOT_KEY = "pi-mobile.lastBot";

/** Which share suggestions fit: photos only, other files, or text. */
const sharedKind = (files: readonly File[]): SharedKind =>
	files.length === 0 ? "text" : files.every((file) => file.type.startsWith("image/")) ? "image" : "file";
/** Set once the database from before bots is gone (or was never there). */
const LEGACY_DELETED_KEY = "pi-mobile.legacyDeleted";
/** A tool's request asked while the user is away is declined when nobody answers for this long. */
const AWAY_APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;

type Overlay = "drawer" | "panel" | "model" | "settings" | "botMemory" | "workspace" | undefined;

export function App() {
	const [settings, setSettings] = useState<Settings>();
	const [runtime, setRuntime] = useState<AgentRuntime>();
	const [openError, setOpenError] = useState("");
	const [bots, setBots] = useState<Bot[]>([]);
	const [controller, setController] = useState<ConversationController>();
	const [view, setView] = useState<ConversationView>();
	const [pendingDraft, setPendingDraft] = useState<string>();
	const [pendingFiles, setPendingFiles] = useState<readonly File[]>();
	const [pendingShared, setPendingShared] = useState<SharedKind>();
	const [overlay, setOverlay] = useState<Overlay>();
	const [dialog, setDialog] = useState<{ request: DialogRequest; resolve: (value: string | boolean | undefined) => void }>();
	const [focusKey, setFocusKey] = useState(0);
	const [prefs, updatePrefs] = usePrefs();
	const [botEdit, setBotEdit] = useState<BotEdit>();
	const [memoryBot, setMemoryBot] = useState<Bot>();
	/** Something shared from another app, waiting for the user to pick the bot it goes to. */
	const [sharing, setSharing] = useState<{ draft: string; files: File[] }>();
	/** Remounts the chat when a bot is opened with a draft, so the composer takes it. */
	const [chatKey, setChatKey] = useState(0);
	const [workspaceStart, setWorkspaceStart] = useState<{ tab: WorkspaceTab; file?: string }>({ tab: "files" });
	const openWorkspace = useCallback((start: { tab: WorkspaceTab; file?: string }) => {
		setWorkspaceStart(start);
		setOverlay("workspace");
	}, []);
	const openFile = useCallback((file: string) => openWorkspace({ tab: "files", file }), [openWorkspace]);
	const close = useCallback(() => setOverlay(undefined), []);
	// Settings save when left, not with a button: the latest edits, and whether they differ from what is saved.
	const settingsDraft = useRef<{ settings: Settings; changed: boolean }>(undefined);
	const onSettingsDraft = useCallback((next: Settings, changed: boolean) => {
		settingsDraft.current = { settings: next, changed };
	}, []);

	const notify = useCallback((message: string) => {
		log.warn("app.notice", { message });
		showToast(message);
	}, []);
	const fail = useCallback((error: unknown) => notify(error instanceof Error ? error.message : String(error)), [notify]);

	// Ask is overloaded (text prompts resolve a string, confirmations a boolean); one implementation serves both.
	const ask = useCallback(
		((request: DialogRequest) =>
			new Promise<string | boolean | undefined>((resolve) => setDialog({ request, resolve }))) as Ask,
		[],
	);

	// Tools ask the user through the same dialog. While pi is away, also with a notification the user can answer
	// without opening pi; whichever is answered first wins, and nobody answering for 30 minutes declines.
	// Read when asked, so a changed setting applies without registering again.
	const approvalAuth = useRef(false);
	approvalAuth.current = settings?.approvalAuth ?? false;
	useEffect(() => {
		setConfirmListener(({ title, detail }) => {
			const request: DialogRequest = { title: "允許這個操作？", body: title, detail, confirm: "允許", cancel: "拒絕", modal: true };
			// With 核准時驗證 on, 允許 also takes the fingerprint (or the screen lock); failing it declines.
			if (inForeground()) {
				return ask(request).then(async (approved) => {
					if (approved !== true || !approvalAuth.current || !Capacitor.isNativePlatform()) return approved === true;
					return (await System.authenticate({ title: "確認是你", subtitle: title })).ok;
				});
			}
			return new Promise<boolean>((resolve) => {
				let settled = false;
				const answer = (approved: boolean) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					cancelNotification();
					endWaiting();
					setDialog((current) => (current?.resolve === answerDialog ? undefined : current));
					resolve(approved);
				};
				const answerDialog = (value: string | boolean | undefined) => answer(value === true);
				setDialog({ request, resolve: answerDialog });
				const endWaiting = showWaiting(title);
				const cancelNotification = askByNotification(detail ? `${title}\n${detail}` : title, answer);
				const timer = setTimeout(() => answer(false), AWAY_APPROVAL_TIMEOUT_MS);
			});
		});
		return () => setConfirmListener(undefined);
	}, [ask]);

	const start = useCallback(
		async (next: Settings) => {
			try {
				const modelIds = AgentRuntime.startModelList(next);
				// Do not leave it unhandled if storage fails first; open() reports a failure.
				modelIds.catch(() => undefined);
				// The database from before bots (v0.1.0) goes, with every old conversation; only the global MEMORY.md stays.
				let importMemory: string | undefined;
				// Once moved, the check (opening SQLite to look for the old file) is skipped on later starts.
				const legacy = localStorage.getItem(LEGACY_DELETED_KEY) ? null : await takeLegacyStorage().catch(() => null);
				if (legacy) {
					importMemory = await AgentRuntime.readLegacyMemory(legacy.storage).catch(() => undefined);
					await legacy.discard().then(
						() => localStorage.setItem(LEGACY_DELETED_KEY, "1"),
						(error: unknown) => log.warn("storage.legacy_discard_failed", { error: String(error) }),
					);
				} else if (legacy === undefined) {
					localStorage.setItem(LEGACY_DELETED_KEY, "1");
				}
				const { storage, fresh } = await openAppStorage();
				// A new database mints bot ids from the start: what other stores kept by id belongs to no bot now.
				if (fresh) {
					await sweepBotData(async () => []);
					localStorage.removeItem(LAST_BOT_KEY);
				}
				const opened = await AgentRuntime.open(storage, next, {
					...(importMemory ? { importMemory } : {}),
					modelIds,
					onReport: notify,
					openUrl: (url) => System.openExternal({ url }),
					notify: async (title, text, conversationId, avatar) => {
						if (inForeground()) return false;
						await Triggers.notify({ title, text, conversation: String(conversationId), ...(avatar ? { avatar } : {}) });
						return true;
					},
				});
				setRuntime(opened);
				// Later, without holding up the start: what a removal cut short.
				setTimeout(() => void sweepBotData(async () => (await opened.bots()).map((bot) => String(bot.id))), 10_000);
				setOpenError("");
			} catch (error) {
				setOpenError(`開啟失敗：${error instanceof Error ? error.message : String(error)}`);
			}
		},
		[notify],
	);

	useEffect(() => {
		void loadSettings().then((loaded) => {
			setSettings(loaded);
			if (isConfigured(loaded)) void start(loaded);
		});
	}, [start]);

	useEffect(() => (runtime ? runtime.subscribeBots(setBots) : undefined), [runtime]);

	// Keep working conversations running in the background; say when one finishes while the app is away.
	const [busyIds, setBusyIds] = useState<ReadonlySet<ConversationId>>(new Set());
	const previousBusy = useRef<ReadonlySet<ConversationId>>(new Set());
	useEffect(() => (runtime ? runtime.subscribeActivity(setBusyIds) : undefined), [runtime]);
	useEffect(() => {
		const title = (id: ConversationId) => bots.find((bot) => bot.id === id)?.name ?? "Bot";
		setWorking([...busyIds].map(title));
		// A triggered run tells the user itself (the notify tool) only when there is something worth it.
		const finished = [...previousBusy.current].filter((id) => !busyIds.has(id) && !runtime?.takeTriggered(id));
		if (finished.length > 0) notifyAway("pi 完成了", finished.map(title).join("、"));
		previousBusy.current = busyIds;
	}, [busyIds, bots, runtime]);

	const openConversation = useCallback(
		async (id: ConversationId, draft?: string, files?: readonly File[], shared?: SharedKind) => {
			if (!runtime) return;
			setOverlay(undefined);
			if (id === controller?.id && draft === undefined) return;
			controller?.dispose();
			const next = await runtime.openConversation(id);
			localStorage.setItem(LAST_BOT_KEY, String(id));
			setChatKey((key) => key + 1);
			setPendingDraft(draft);
			setPendingFiles(files);
			setPendingShared(shared);
			setView(undefined);
			setController(next);
		},
		[runtime, controller],
	);

	// The open bot was deleted by something other than its menu (a test, a script): close it, and the effect below
	// opens another. Checked against a fresh list, since a bot just created can be open before the list reaches us.
	useEffect(() => {
		if (!runtime || !controller) return;
		if (bots.some((bot) => bot.id === controller.id)) return;
		let live = true;
		void runtime.bots().then((items) => {
			if (!live || items.some((bot) => bot.id === controller.id)) return;
			controller.dispose();
			setController(undefined);
			setView(undefined);
		});
		return () => {
			live = false;
		};
	}, [runtime, controller, bots]);

	// Open the last bot once the runtime is ready.
	useEffect(() => {
		if (!runtime || controller) return;
		void runtime.bots().then((items) => {
			const last = localStorage.getItem(LAST_BOT_KEY);
			const target = items.find((bot) => String(bot.id) === last) ?? items[0];
			if (target) void openConversation(target.id);
		});
	}, [runtime, controller, openConversation]);

	// Fired schedules and shares from other apps. A share goes into a bot's composer, so the user says what to do with
	// it: the only bot's, or the one the user picks.
	const openRef = useRef(openConversation);
	openRef.current = openConversation;
	useEffect(() => {
		if (!runtime) return;
		const onShare = async (item: SharedItem) => {
			// The native side copied each file into its inbox; Capacitor's file server hands it to the WebView as is.
			const files = await Promise.all(
				(item.files ?? []).map(async (file) => {
					const blob = await (await fetch(Capacitor.convertFileSrc(file.path))).blob();
					return new File([blob], file.name, { type: file.mimeType || blob.type });
				}),
			);
			const draft = [item.subject, item.text].filter((part) => part && part.trim()).join("\n");
			if (!draft && files.length === 0) {
				notify("沒有讀到分享的內容。");
				return;
			}
			const items = await runtime.bots();
			const kind = item.source === "assist" ? "screen" : sharedKind(files);
			// The screen goes to the bot the user was in: summoning pi is for a quick question, not a choice.
			const last = items.find((bot) => String(bot.id) === localStorage.getItem(LAST_BOT_KEY)) ?? (items.length === 1 ? items[0] : undefined);
			if (last && (kind === "screen" || items.length === 1)) await openRef.current(last.id, item.source === "assist" ? "" : draft, files, kind);
			else setSharing({ draft, files });
		};
		const stopEvents = processTriggerEvents(runtime, { onShare, onOpened: (id) => void openRef.current(id) });
		const stopLinks = listenForOpenLinks((conversation) => {
			void runtime.bots().then((items) => {
				const target = items.find((bot) => String(bot.id) === conversation);
				if (target) void openRef.current(target.id);
			});
		});
		return () => {
			stopEvents();
			stopLinks();
		};
	}, [runtime, notify]);

	// Debug hook for test/cdp.ts.
	useEffect(() => {
		Object.assign(globalThis, { piRuntime: runtime, piController: controller });
	}, [runtime, controller]);

	const controllerId = controller?.id;
	const loadWorkspace = useCallback(
		() => (runtime && controllerId !== undefined ? runtime.workspace(controllerId) : Promise.resolve(undefined)),
		[runtime, controllerId],
	);

	// Pairing links from sandbox/install.sh. A link can arrive before settings load (the app was launched with it).
	const [pairing, setPairing] = useState<Pairing>();
	useEffect(() => listenForPairing(setPairing), []);
	const saveRef = useRef<(next: Settings) => Promise<void>>(undefined);
	useEffect(() => {
		if (!pairing || !settings) return;
		setPairing(undefined);
		void (async () => {
			let reached: string;
			try {
				reached = await checkSandbox(pairing.url, pairing.token);
			} catch (error) {
				notify(`連不到 sandbox 主機 ${pairing.name}：${error instanceof Error ? error.message : String(error)}`);
				return;
			}
			const replacing = settings.sandboxUrl && settings.sandboxUrl !== pairing.url;
			const sure = await ask({
				title: "使用這台 sandbox 主機？",
				body: `${pairing.name}（${reached}）。${replacing ? `會取代目前的 ${settings.sandboxUrl}，舊主機上的檔案不會搬過來。` : "所有 Bot 會共用這台主機上的一個 Linux 容器。"}`,
				confirm: "使用",
			});
			if (!sure) return;
			await saveRef.current?.({ ...settings, sandboxUrl: pairing.url, sandboxToken: pairing.token });
			notify(`已連上 sandbox 主機 ${pairing.name}`);
		})();
	}, [pairing, settings, ask, notify]);

	// The side panels: the bot list on the left, the bot on screen on the right (SidePanel.tsx).
	const side = overlay === "drawer" ? "left" : overlay === "panel" ? "right" : undefined;
	const sideBlocked = (overlay !== undefined && side === undefined) || dialog !== undefined || botEdit !== undefined || sharing !== undefined;

	// Until the runtime opens (about half a second, most of it loading the app), its outline, as index.html showed.
	const splash = <Skeleton />;
	if (!settings) return splash;

	const saveAndRestart = async (edited: Settings) => {
		const next = await saveSettings(edited);
		setSettings(next);
		// First run: a paired sandbox is saved, but the agent starts only once the model service is filled in.
		if (!isConfigured(next)) return;
		setOverlay(undefined);
		controller?.dispose();
		setController(undefined);
		setView(undefined);
		await runtime?.close();
		setRuntime(undefined);
		await start(next);
	};
	saveRef.current = saveAndRestart;
	function leaveSettings() {
		const draft = settingsDraft.current;
		settingsDraft.current = undefined;
		if (!draft?.changed) return close();
		if (!isConfigured(draft.settings)) {
			notify("沒有可用的模型供應商，變更沒有儲存");
			return close();
		}
		void saveAndRestart(draft.settings).catch(fail);
	}

	if (!runtime) {
		if (isConfigured(settings) && !openError) return splash;
		// First run, or the runtime could not open: settings are the whole screen.
		return (
			<div className="app">
				{/* Remount when pairing fills in the sandbox, so the form shows it. */}
				<SettingsView key={settings.sandboxUrl} initial={settings} status={openError} onSave={saveAndRestart} />
				<Dialog
					request={dialog?.request}
					onAnswer={(value) => {
						dialog?.resolve(value);
						setDialog(undefined);
					}}
				/>
			</div>
		);
	}

	const agent = agentOf(view);
	const modelId = agent?.model?.modelId ?? "";
	const modelProvider = agent?.model?.provider ?? "";
	const thinking = agent?.thinkingLevel ?? "";
	const model = runtime.models.find((candidate) => candidate.provider === modelProvider && candidate.id === modelId);
	const current = bots.find((bot) => bot.id === controller?.id);
	const used = contextTokens(view);
	const contextWindow = model?.contextWindow ?? 0;
	const busy = isBusy(view);

	return (
		<div
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
				<button type="button" className="icon-button" aria-label="Bot 資訊" onClick={() => setOverlay("panel")}>
					<MoreIcon />
				</button>
				<div className="meter" aria-hidden="true">
					<i style={{ width: `${contextWindow ? Math.min(100, (used / contextWindow) * 100) : 0}%` }} />
				</div>
			</header>

			<SideSwipe
				open={side}
				disabled={sideBlocked}
				onChange={(next) => setOverlay(next === "left" ? "drawer" : next === "right" ? "panel" : undefined)}
				left={
					<Drawer
						open={overlay === "drawer"}
						busy={busy}
						bots={bots}
						currentId={controller?.id}
						status={[
							{ label: "GitHub", icon: <GitHubMark />, on: Boolean(settings.githubToken) },
							{ label: "Sandbox", icon: <TerminalIcon size={17} />, on: runtime.hasSandbox },
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
						usage={totalUsage(view)}
						cacheHitRate={latestCacheHitRate(view)}
						context={{ used, window: contextWindow }}
						compactAt={settings.compactAt}
						prefs={prefs}
						onPrefs={updatePrefs}
						onError={notify}
						onClose={close}
						actions={{
							edit: () => {
								if (current) setBotEdit({ kind: "edit", bot: current });
							},
							memory: () => {
								if (!current) return;
								setMemoryBot(current);
								setOverlay("botMemory");
							},
							copy: (text) => navigator.clipboard.writeText(text).then(() => notify("已複製最後的回答"), fail),
							compact: () => {
								if (!controller) return;
								notify("壓縮中…");
								controller.compact().then((done) => notify(done ? "已把較早的對話壓縮成摘要" : "對話還短，不需要壓縮"), fail);
							},
							reset: async () => {
								if (!controller) return;
								const sure = await ask({
									title: "新的上下文",
									body: "模型將看不到這之前的訊息。紀錄仍會留在畫面上。",
									confirm: "開始新的上下文",
								});
								if (sure) await controller.reset().catch(fail);
							},
							workspace: runtime.hasSandbox ? () => openWorkspace({ tab: "files" }) : undefined,
							emptyFolder: runtime.hasSandbox
								? async () => {
										if (!controller) return;
										const sure = await ask({
											title: "清空資料夾",
											body: `${current?.name ?? "這個 Bot"} 在 sandbox 裡的資料夾和所有檔案都會刪除。其他 Bot 的資料夾不受影響。`,
											confirm: "清空",
											danger: true,
										});
										if (sure) await runtime.resetSandbox(controller.id).then(() => notify("已清空資料夾"), fail);
									}
								: undefined,
						}}
					/>
				}
			>
				{controller ? (
					<OpenFileContext.Provider value={runtime.hasSandbox ? openFile : undefined}>
					<Chat
						key={`${String(controller.id)}-${chatKey}`}
						controller={controller}
						prefs={prefs}
						capabilities={{ sandbox: runtime.hasSandbox }}
						initialDraft={pendingDraft}
						initialFiles={pendingFiles}
						shared={pendingShared}
						focusKey={focusKey}
						onView={setView}
						onError={notify}
						onNotice={notify}
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
					setMemoryBot(bot);
					setOverlay("botMemory");
				}}
				onDelete={async (bot) => {
					setBotEdit(undefined);
					const sure = await ask({
						title: `刪除 ${bot.name}`,
						body: "它的對話、記憶、排程和 sandbox 資料夾都會刪除，無法復原。",
						confirm: "刪除",
						danger: true,
					});
					if (!sure) return;
					try {
						await runtime.removeBot(bot.id);
						await clearDraft(String(bot.id)).catch(() => undefined);
						if (bot.id === controller?.id) {
							controller.dispose();
							setController(undefined);
							setView(undefined);
						}
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
								<span className="menu-hint">{bot.job.split("\n")[0] || "一般助理"}</span>
							</span>
						</button>
					))}
				</div>
			</Sheet>

			<WorkspaceView open={overlay === "workspace"} load={loadWorkspace} initial={workspaceStart} onClose={close} />

			<Layer open={overlay === "botMemory" && Boolean(memoryBot)} kind="page" onClose={close} label="Bot 的記憶">
				{memoryBot ? (
					<MemoryView runtime={runtime} scope={{ kind: "bot", id: memoryBot.id }} botName={memoryBot.name} onClose={close} onError={notify} />
				) : null}
			</Layer>

			<Layer open={overlay === "settings"} kind="page" onClose={leaveSettings} label="設定">
				<SettingsView initial={settings} runtime={runtime} onCancel={leaveSettings} onDraft={onSettingsDraft} onSave={saveAndRestart} />
			</Layer>

			<Dialog
				request={dialog?.request}
				onAnswer={(value) => {
					dialog?.resolve(value);
					setDialog(undefined);
				}}
			/>

		</div>
	);
}
