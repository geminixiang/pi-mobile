import { useCallback, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import type { Bot } from "../agent/bots.ts";
import type { ConversationId } from "../runtime/runtime.ts";
import { isConfigured } from "../settings.ts";
import { BotAvatar } from "../agent/BotAvatar.tsx";
import { BotSheet, type BotEdit } from "./bots/BotSheet.tsx";
import { ItemSheet } from "../items/ItemSheet.tsx";
import { Chat, isBusy } from "./chat/Chat.tsx";
import { BotPanel } from "./bots/BotPanel.tsx";
import { Dialog, type DialogRequest, Sheet } from "pi-mobile-ui/shell";
import { Drawer } from "./Drawer.tsx";
import { FolderIcon, MoreIcon, PiMark, RowList, TerminalIcon } from "pi-mobile-ui/elements";
import { ACCOUNTS, linked } from "../clouds/accounts.tsx";
import { BrowserButton } from "../browser/BrowserButton.tsx";
import { askForBrowser, type BrowserScreen, BrowserSheet } from "../browser/BrowserSheet.tsx";
import { type BrowserState, browserState, NO_BROWSER } from "../browser/tool.ts";
import { type PageHost, PageHostContext } from "../interaction/PageFrame.tsx";
import { ModelSheet, shortModelName, thinkingLabel } from "./bots/ModelSheet.tsx";
import { Skeleton, TranscriptSkeleton } from "./Skeleton.tsx";
import { usePrefs } from "./prefs.ts";
import { type Source, useSubscribed } from "pi-mobile-ui/store";
import { choose, closeItem, closeSettings, dismissNotices, draftSettings, leave, leftPanel, memoryPage, notify, open, rightPanel, saveAndRestart, session, sharedKind, show, stopSharing, watchSession } from "./session.ts";
import { SettingsView } from "./settings/Settings.tsx";
import { MemoryView } from "../memory/MemoryView.tsx";
import { OpenFileContext } from "pi-mobile-ui/message";
import { JobsContext } from "../jobs/JobsContext.ts";
import { PageStack } from "./PageStack.tsx";
import { WorkspaceView } from "./files/WorkspaceView.tsx";
import { SidePanel } from "./SidePanel.tsx";
import type { BotListProps } from "./bots/BotList.tsx";
import { benchOf, benchStep, emptyBench, FOLDER, fileKey, pathOf } from "../workbench/bench.ts";
import { boardOf } from "../workbench/board.ts";
import { layout as screenLayout, shownOverlay, useLayout } from "../workbench/layout.ts";
import { BesideContext } from "../beside.ts";
import { Rail } from "../workbench/Rail.tsx";
import { Workbench } from "../workbench/Workbench.tsx";
import { agentOf, liveOf } from "./docs.ts";
import { native } from "../native.ts";
import { NO_TRIGGERS, type TriggerState } from "../triggers/runs.ts";
import { System } from "../plugins/system.ts";
import { contextPercent, contextTokens } from "./bots/usage.ts";
import { SideSwipe } from "./SidePanel.tsx";
import { clearDraft } from "./chat/drafts.ts";
import { messageOf, orLogged } from "pi-mobile-base/promise";
import { windowFor } from "../agent/models.ts";
import { ModelLine } from "./bots/Links.tsx";
import { modelReach } from "../net/reach.ts";

const watchScreen = (changed: () => void) => {
	const stops = [watchSession(changed), screenLayout.subscribe(changed)];
	return () => stops.forEach((stop) => stop());
};
const rootPage: Source<boolean> = { subscribe: watchScreen, read: () => session().overlay === (screenLayout.read() === "phone" ? "workspace" : "settings") };
const browserScreen: Source<BrowserScreen> = {
	subscribe: watchScreen,
	read: () => {
		const { controller, asking, overlay } = session();
		return { bot: controller ? String(controller.id) : undefined, asking, hidden: shownOverlay(overlay, screenLayout.read()) !== undefined };
	},
};

export function App() {
	const { settings, runtime, openError, controller, view, asking, opening, chatKey, pending, overlay, sharing, openItem, notices } = useSyncExternalStore(watchSession, session);
	const [dialog, setDialog] = useState<{ request: DialogRequest; resolve: (sure: boolean) => void }>();
	const [prefs, updatePrefs] = usePrefs();
	const [botEdit, setBotEdit] = useState<BotEdit>();
	const [memoryBot, setMemoryBot] = useState<Bot>();
	const [picked, setPicked] = useState<{ path: string; text: string }>();
	const clearPicked = useCallback(() => setPicked(undefined), []);
	const currentBot = controller ? String(controller.id) : undefined;
	const layout = useLayout();
	const [benchState, benchDispatch] = useReducer(benchStep, undefined, emptyBench);
	const bench = benchOf(benchState, currentBot);
	const present = useCallback(
		(key: string) => {
			if (currentBot) benchDispatch({ type: "show", bot: currentBot, key });
			if (layout === "phone") show("workspace");
		},
		[currentBot, layout],
	);
	const openFile = useCallback((path: string) => present(fileKey(path)), [present]);
	const openInfo = useCallback(() => show("panel"), []);
	const close = useCallback(() => show(undefined), []);
	const backToPanel = useCallback(() => show("panel"), []);
	const backToDrawer = useCallback(() => show(layout === "phone" ? "drawer" : undefined), [layout]);

	const fail = (error: unknown) => notify(messageOf(error));
	const ask = useCallback((request: DialogRequest) => new Promise<boolean>((resolve) => setDialog({ request, resolve })), []);

	const bots = useSubscribed<Bot[]>([], (listener) => runtime?.subscribeBots(listener), [runtime]);
	const triggerState = useSubscribed<TriggerState>(NO_TRIGGERS, (listener) => runtime?.triggers.subscribe(listener), [runtime]);
	const automations = triggerState.items;
	const jobs = useMemo(() => (runtime && controller ? runtime.jobs.of(controller.id, automations) : undefined), [automations, controller, runtime]);
	const formsState = useSyncExternalStore(
		useCallback((listener: () => void) => (runtime ? runtime.forms.subscribe(listener) : () => undefined), [runtime]),
		() => runtime?.forms.state,
	);
	const browser = useSubscribed<BrowserState>(NO_BROWSER, (listener) => browserState.subscribe(listener), []);
	const busyIds = useSubscribed<ReadonlySet<ConversationId>>(new Set(), (listener) => runtime?.subscribeActivity(listener), [runtime]);

	const liveTools = liveOf(view)?.tools;
	const board = useMemo(
		() =>
			layout !== "phone" && controller
				? boardOf(
						{
							bot: controller.id,
							entries: view?.entries ?? [],
							tools: liveTools ?? [],
							forms: formsState?.pending ?? new Map(),
							items: triggerState.open,
							triggers: triggerState.items,
							next: triggerState.next,
							browser: { active: currentBot !== undefined && browser.active.has(currentBot), handover: browser.handovers.find((handover) => handover.bot === currentBot)?.reason },
						},
						bench,
					)
				: undefined,
		[layout, controller, view?.entries, liveTools, formsState, triggerState, browser, currentBot, bench],
	);
	const waiting = useMemo(
		() =>
			new Set([
				...[...(formsState?.pending.values() ?? [])].map((form) => form.conversationId),
				...triggerState.open.flatMap((item) => (item.state === "todo" ? [item.bot] : [])),
				...(asking && controller ? [controller.id] : []),
			]),
		[formsState, triggerState.open, asking, controller],
	);

	const controllerId = controller?.id;
	const loadWorkspace = useCallback(() => (runtime && controllerId !== undefined ? runtime.workspace(controllerId) : Promise.resolve(undefined)), [runtime, controllerId]);

	const pageHost = useMemo<PageHost>(
		() => ({
			read: async (path) => {
				const content = await orLogged(loadWorkspace().then((workspace) => workspace?.read(path)), "page_frame.read_failed", undefined);
				return content?.kind === "text" ? content.text : undefined;
			},
			openSide: (next) => show(next === "left" ? "drawer" : "panel"),
		}),
		[loadWorkspace],
	);

	const card = useRef<HTMLDivElement>(null);
	const header = useRef<HTMLElement>(null);

	const side = overlay === "drawer" || overlay === "settings" ? "left" : overlay === "panel" || overlay === "botMemory" ? "right" : undefined;
	const sideBlocked = (overlay !== undefined && side === undefined) || overlay === "settings" || overlay === "botMemory" || dialog !== undefined || botEdit !== undefined || sharing !== undefined;

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

	const leaveSettings = () => {
		const closed = closeSettings();
		if (closed.state === "closed") return backToDrawer();
		void ask({ title: "變更沒有儲存", body: "沒有可用的模型供應商。離開會放棄這次的變更。", confirm: "放棄變更", danger: true }).then((sure) => (sure ? backToDrawer() : closed.keep()));
	};

	if (!runtime) {
		if (isConfigured(settings) && !openError) return splash;
		return (
			<div className="app">
				<SettingsView mode="setup" initial={settings} status={openError} prefs={prefs} onPrefs={updatePrefs} onSave={saveAndRestart} />
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
	const contextWindow = model ? windowFor(model.contextWindow, settings.compactAt) : 0;
	const busy = isBusy(view);
	const avatar = <>{current ? <BotAvatar bot={current} size={26} /> : <PiMark size={18} />}{busy ? <i className="bar-busy" /> : null}</>;
	const changeModel = async ({ model: nextModel, thinking: nextThinking }: { model?: { provider: string; id: string }; thinking?: string }) => {
		if (!controller) return;
		if (nextModel) await controller.setModel(nextModel.provider, nextModel.id).catch(fail);
		if (nextThinking) await controller.setThinking(nextThinking).catch(fail);
	};
	const openMemory = (bot: Bot) => {
		setMemoryBot(bot);
		show("botMemory");
	};
	const wide = layout !== "phone";
	const shown = shownOverlay(overlay, layout);
	const list: BotListProps = {
		bots,
		automations,
		currentId: opening ?? controller?.id,
		running: busyIds,
		waiting,
		onOpen: choose,
		onCreate: () => setBotEdit({ kind: "create" }),
		onEdit: (bot) => setBotEdit({ kind: "edit", bot }),
	};
	const settingsView = <SettingsView mode="app" initial={settings} runtime={runtime} prefs={prefs} onPrefs={updatePrefs} onCancel={leaveSettings} onDraft={draftSettings} />;
	const memoryView = memoryBot ? <MemoryView memories={runtime.memories} scope={{ kind: "bot", id: memoryBot.id }} bot={memoryBot} onClose={backToPanel} onError={notify} /> : null;
	const botPanel = (open: boolean, onClose: () => void) => (
		<BotPanel
			open={open}
			bot={current}
			runtime={runtime}
			view={view}
			context={{ used, window: contextWindow }}
			compactAt={settings.compactAt}
			model={{ provider: modelProvider, id: modelId, name: shortModelName(model?.name ?? modelId), thinking }}
			busy={busy}
			onClose={onClose}
			actions={{
				model: (change) => void changeModel(change),
				edit: () => {
					if (current) setBotEdit({ kind: "edit", bot: current });
				},
				ask: (text) => {
					if (controller) controller.send([{ type: "text", text }]).catch(fail);
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
						confirm: "開始",
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
	);
	const stackTop = wide
		? overlay === "settings" ? { key: "settings", content: settingsView, onBack: leaveSettings } : undefined
		: overlay === "workspace" ? { key: "workspace", content: <WorkspaceView load={loadWorkspace} initial={{ tab: "files", file: pathOf(bench.pick) }} onClose={close} />, onBack: close } : undefined;
	const staged = board?.stage;
	const shownFile = staged?.kind === "file" && (board?.pinned || bench.opened.includes(staged.path)) ? staged.path : undefined;
	const inView = staged?.kind === "ask" ? staged.draft?.path : shownFile;

	return (
		<PageStack side={wide ? "left" : "right"} opened={rootPage} top={stackTop}>
		<div className={`frame frame-${layout}${wide ? " frame-wide" : ""}`}>
		{wide ? <Rail busy={busy} list={list} onSettings={() => show("settings")} /> : null}
		<div
			ref={card}
			data-thinking={thinking || "off"}
			className="app"
		>
			<header ref={header} className="bar chat-bar">
				<div className="bar-pill bar-who">
					{wide ? (
						<span className="bar-avatar">{avatar}</span>
					) : (
						<button type="button" className="bar-avatar" onClick={() => show("drawer")} aria-label="Bot 列表">
							{avatar}
						</button>
					)}
					<button type="button" className="bar-what" onClick={() => (wide || modelReach(modelProvider).state().kind === "down" ? openInfo() : show("model"))} aria-label="模型與思考強度">
						<span className="bar-title">
							{current?.name ?? ""}
						</span>
						<ModelLine provider={modelProvider}>
							{shortModelName(model?.name ?? modelId)}
							{thinking && thinking !== "off" ? ` · 思考${thinkingLabel(thinking)}` : ""}
						</ModelLine>
						<svg className="bar-context" viewBox="0 0 22 22" aria-hidden="true">
							<circle cx="11" cy="11" r="8.5" />
							<circle className="used" cx="11" cy="11" r="8.5" pathLength={1} style={{ "--fill": contextPercent(used, contextWindow) / 100 }} />
						</svg>
					</button>
				</div>
				<div className="bar-pill bar-tools">
					{currentBot && native.has("Browser") ? (
						<BrowserButton bot={currentBot} onOpen={askForBrowser} />
					) : null}
					{hasFolder ? (
						<button type="button" className="icon-button" aria-label="資料夾" onClick={() => present(FOLDER)}>
							<FolderIcon />
						</button>
					) : null}
					<button type="button" className="icon-button" aria-label="Bot 資訊" onClick={openInfo}>
						<MoreIcon />
					</button>
				</div>
			</header>

			<SideSwipe
				card={card}
				open={wide ? undefined : side}
				disabled={wide || sideBlocked}
				onChange={(next) => show(next === "left" ? "drawer" : next === "right" ? "panel" : undefined)}
				left={
					wide ? null : (
						<Drawer
							place={leftPanel}
							page={{ label: "設定", onBack: leaveSettings, content: settingsView }}
							busy={busy}
							list={list}
							status={[
								...ACCOUNTS.map((account) => ({ label: account.name, icon: account.mark, on: linked(account, settings) })),
								{ label: "電腦", icon: <TerminalIcon size={17} />, on: runtime.workplaces.any },
							]}
							onSettings={() => show("settings")}
							onClose={close}
						/>
					)
				}
				right={
					wide || !current ? null : (
						<SidePanel
							side="right"
							place={rightPanel}
							page={{ label: "Bot 的記憶", onBack: backToPanel, content: memoryView }}
							onClose={close}
							label={`${current.name} 的資訊`}
						>
							{botPanel(overlay === "panel" || overlay === "botMemory", close)}
						</SidePanel>
					)
				}
			>
				{controller ? (
					<OpenFileContext.Provider value={hasFolder ? openFile : undefined}>
					<BesideContext.Provider value={wide ? { inView, part: picked?.path === inView ? picked?.text : undefined, clearPart: clearPicked } : undefined}>
					<PageHostContext.Provider value={pageHost}>
					<JobsContext.Provider value={jobs}>
					<Chat
						key={`${String(controller.id)}-${chatKey}`}
						controller={controller}
						forms={runtime.forms}
						prefs={prefs}
						sandbox={onSandbox}
						botName={current?.name ?? "pi"}
						view={view}
						shared={pending.shared}
						focus={pending.focus}
						notices={notices}
						onDismissNotices={dismissNotices}
						onError={notify}
						contextShare={contextWindow > 0 ? used / contextWindow : 0}
						provider={modelProvider}
					/>
					</JobsContext.Provider>
					</PageHostContext.Provider>
					</BesideContext.Provider>
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
				onChange={async (change) => {
					await changeModel(change);
					if (change.model) close();
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
							await open(id, { focus: true });
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
						await orLogged(clearDraft(String(bot.id)), "drafts.clear_failed", undefined);
						leave(bot.id);
					} catch (error) {
						fail(error);
					}
				}}
			/>

			{runtime ? (
				<ItemSheet
					runs={runtime.triggers} bots={() => runtime.bots()}
					id={openItem}
					onDraft={(conversation, draft) => void open(conversation, { draft })}
					onClose={closeItem}
				/>
			) : null}

			<Sheet open={Boolean(sharing)} title="要交給哪個 Bot？" onClose={stopSharing}>
				<RowList>
					{bots.map((bot) => (
						<button
							type="button"
							key={String(bot.id)}
							onClick={() => {
								const item = sharing;
								stopSharing();
								if (item) void open(bot.id, { draft: item.draft, files: item.files, shared: sharedKind(item.files) });
							}}
						>
							<BotAvatar bot={bot} size={32} />
							<span className="menu-text">
								{bot.name}
								{bot.job.trim() ? <span className="menu-hint">{bot.job.split("\n")[0]}</span> : null}
							</span>
						</button>
					))}
				</RowList>
			</Sheet>

			<BrowserSheet screen={browserScreen} pullFrom={header} engine={settings.searchEngine} />

			{dialogView}
		</div>
		{board && controller ? (
			<Workbench
				bot={current}
				board={board}
				runtime={runtime}
				conversation={controller.id}
				load={loadWorkspace}
				picked={picked}
				onInfo={openInfo}
				onCloseInfo={close}
				info={
					shown === "panel" || shown === "botMemory" ? (
						<PageStack side="right" opened={memoryPage} top={shown === "botMemory" && memoryView ? { key: "memory", content: memoryView, onBack: backToPanel } : undefined}>
							{botPanel(true, close)}
						</PageStack>
					) : undefined
				}
				actions={{
					show: present,
					close: (key) => {
						if (currentBot) benchDispatch({ type: "close", bot: currentBot, key });
					},
					ask: (text) => void controller.send([{ type: "text", text }]).catch(fail),
					draft: (draft) => void open(controller.id, { draft }),
					reply: (text) => void controller.send([{ type: "text", text }], "steer").catch(fail),
					answerForm: (callId, answer) => runtime.forms.answer(callId, answer),
					// why: the composer's stop also puts messages the stop withdrew back into the draft, which only Chat holds
					stopTurn: () => document.querySelector<HTMLButtonElement>(".composer .send.stop")?.click(),
					browser: askForBrowser,
					openUrl: (url) => void System.openExternal({ url }).catch(fail),
					pick: (path, text) => {
						setPicked({ path, text });
						document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
					},
				}}
			/>
		) : null}
		</div>
		</PageStack>
	);
}
