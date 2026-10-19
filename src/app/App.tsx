import type { ConversationView } from "@earendil-works/pi-durable";
import { useCallback, useEffect, useState } from "react";
import { type ConfirmRequest, setConfirmListener } from "../agent/confirm.ts";
import { AgentRuntime, type ConversationController, type ConversationId, type ConversationSummary } from "../agent/runtime.ts";
import { isConfigured, loadSettings, type Settings, saveSettings } from "../settings.ts";
import { openAppStorage } from "../storage.ts";
import { Chat } from "./Chat.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { ConversationMenu } from "./ConversationMenu.tsx";
import { Drawer } from "./Drawer.tsx";
import { ComposeIcon, MenuIcon, MoreIcon } from "./icons.tsx";
import { ModelSheet, ThinkingBars } from "./ModelSheet.tsx";
import { usePrefs } from "./prefs.ts";
import { SettingsView } from "./Settings.tsx";
import { contextTokens, totalUsage } from "./usage.ts";

const LAST_CONVERSATION_KEY = "pi-mobile.lastConversation";

type Screen = "loading" | "settings" | "chat";
type Overlay = "drawer" | "model" | "menu" | undefined;

export function App() {
	const [screen, setScreen] = useState<Screen>("loading");
	const [settings, setSettings] = useState<Settings>();
	const [runtime, setRuntime] = useState<AgentRuntime>();
	const [conversations, setConversations] = useState<ConversationSummary[]>([]);
	const [controller, setController] = useState<ConversationController>();
	const [view, setView] = useState<ConversationView>();
	const [pendingDraft, setPendingDraft] = useState<string>();
	const [overlay, setOverlay] = useState<Overlay>();
	const [confirm, setConfirm] = useState<{ request: ConfirmRequest; resolve: (approved: boolean) => void }>();
	const [toast, setToast] = useState("");
	const [openError, setOpenError] = useState("");
	const [prefs, updatePrefs] = usePrefs();

	const notify = useCallback((message: string) => {
		console.warn(message);
		setToast(message);
	}, []);

	useEffect(() => {
		if (!toast) return;
		const timer = setTimeout(() => setToast(""), 4000);
		return () => clearTimeout(timer);
	}, [toast]);

	// Tools ask the user through this dialog.
	useEffect(() => {
		setConfirmListener((request) => new Promise((resolve) => setConfirm({ request, resolve })));
		return () => setConfirmListener(undefined);
	}, []);

	const start = useCallback(
		async (next: Settings) => {
			setScreen("loading");
			try {
				const { storage } = await openAppStorage();
				setRuntime(await AgentRuntime.open(storage, next, { onReport: notify }));
				setOpenError("");
				setScreen("chat");
			} catch (error) {
				setOpenError(`開啟失敗：${error instanceof Error ? error.message : String(error)}`);
				setScreen("settings");
			}
		},
		[notify],
	);

	useEffect(() => {
		void loadSettings().then((loaded) => {
			setSettings(loaded);
			if (isConfigured(loaded)) void start(loaded);
			else setScreen("settings");
		});
	}, [start]);

	useEffect(() => (runtime ? runtime.subscribeConversations(setConversations) : undefined), [runtime]);

	const openConversation = useCallback(
		async (id: ConversationId, draft?: string) => {
			if (!runtime) return;
			controller?.dispose();
			const next = await runtime.openConversation(id);
			localStorage.setItem(LAST_CONVERSATION_KEY, String(id));
			setPendingDraft(draft);
			setView(undefined);
			setController(next);
			setOverlay(undefined);
		},
		[runtime, controller],
	);

	const createConversation = useCallback(async () => {
		if (runtime) await openConversation(await runtime.createConversation());
	}, [runtime, openConversation]);

	// Open the last conversation once the runtime is ready, or start one when there is none.
	useEffect(() => {
		if (!runtime || controller) return;
		void runtime.conversations().then((items) => {
			const last = localStorage.getItem(LAST_CONVERSATION_KEY);
			const target = items.find((item) => String(item.id) === last) ?? items[0];
			if (target) void openConversation(target.id);
			else void createConversation();
		});
	}, [runtime, controller, openConversation, createConversation]);

	// Debug hook for test/cdp.ts.
	useEffect(() => {
		Object.assign(globalThis, { piRuntime: runtime, piController: controller });
	}, [runtime, controller]);

	if (screen === "loading" || !settings) {
		return (
			<div className="splash">
				<span className="wordmark large">pi</span>
			</div>
		);
	}

	if (screen === "settings") {
		return (
			<SettingsView
				initial={settings}
				status={openError}
				onCancel={runtime ? () => setScreen("chat") : undefined}
				onSave={async (next) => {
					await saveSettings(next);
					setSettings(next);
					controller?.dispose();
					setController(undefined);
					await runtime?.close();
					setRuntime(undefined);
					await start(next);
				}}
			/>
		);
	}

	const agent = view?.docs["pi.agent"] as { model?: { modelId: string }; thinkingLevel?: string } | undefined;
	const modelId = agent?.model?.modelId ?? "";
	const thinking = agent?.thinkingLevel ?? "";
	const model = runtime?.models.find((candidate) => candidate.id === modelId);
	const current = conversations.find((item) => item.id === controller?.id);
	const used = contextTokens(view);
	const contextWindow = model?.contextWindow ?? 0;
	const fail = (error: unknown) => notify(error instanceof Error ? error.message : String(error));

	return (
		<div className="app">
			<header className="bar">
				<button type="button" className="icon-button" onClick={() => setOverlay("drawer")} aria-label="對話列表">
					<MenuIcon />
				</button>
				<div className="bar-center">
					<h1 className="bar-title">{current?.title ?? ""}</h1>
					<button type="button" className="model-pill" onClick={() => setOverlay("model")} aria-label="模型與思考強度">
						<span>{model?.name ?? modelId}</span>
						<ThinkingBars level={thinking} />
					</button>
				</div>
				<button type="button" className="icon-button" aria-label="新對話" onClick={() => void createConversation()}>
					<ComposeIcon />
				</button>
				<button type="button" className="icon-button" aria-label="更多" onClick={() => setOverlay("menu")}>
					<MoreIcon />
				</button>
				<div className="meter" title={`上下文 ${used} / ${contextWindow}`}>
					<i style={{ width: `${contextWindow ? Math.min(100, (used / contextWindow) * 100) : 0}%` }} />
				</div>
			</header>

			{controller ? (
				<Chat
					key={String(controller.id)}
					controller={controller}
					prefs={prefs}
					capabilities={{ github: Boolean(settings.githubToken), sandbox: Boolean(runtime?.hasSandbox) }}
					initialDraft={pendingDraft}
					onView={setView}
					onOpenConversation={(id, draft) => void openConversation(id, draft)}
					onError={notify}
				/>
			) : (
				<div className="chat" />
			)}

			{toast ? (
				<button type="button" className="toast" onClick={() => setToast("")}>
					{toast}
				</button>
			) : null}

			{overlay === "drawer" ? (
				<Drawer
					conversations={conversations}
					currentId={controller?.id}
					status={[
						{ label: "GitHub", on: Boolean(settings.githubToken) },
						{ label: "Sandbox", on: Boolean(runtime?.hasSandbox) },
					]}
					onOpen={(id) => void openConversation(id)}
					onCreate={() => void createConversation()}
					onRemove={async (item) => {
						if (!runtime || !window.confirm(`刪除「${item.title}」？它的 sandbox 也會一起刪除。`)) return;
						await runtime.removeConversation(item.id);
						if (item.id === controller?.id) {
							controller.dispose();
							setController(undefined);
						}
					}}
					onSettings={() => {
						setOverlay(undefined);
						setScreen("settings");
					}}
					onClose={() => setOverlay(undefined)}
				/>
			) : null}

			{overlay === "model" && runtime && controller ? (
				<ModelSheet
					models={runtime.models}
					modelId={modelId}
					thinking={thinking}
					onClose={() => setOverlay(undefined)}
					onChange={async ({ modelId: nextModel, thinking: nextThinking }) => {
						if (nextModel) await controller.setModel(nextModel).catch(fail);
						if (nextThinking) await controller.setThinking(nextThinking).catch(fail);
						if (nextModel) setOverlay(undefined);
					}}
				/>
			) : null}

			{overlay === "menu" && runtime && controller ? (
				<ConversationMenu
					view={view}
					title={current?.title ?? ""}
					usage={totalUsage(view)}
					prefs={prefs}
					onPrefs={updatePrefs}
					onClose={() => setOverlay(undefined)}
					actions={{
						rename: () => {
							const title = window.prompt("對話名稱", current?.title ?? "");
							if (title?.trim()) runtime.renameConversation(controller.id, title.trim()).catch(fail);
						},
						copy: (text) => navigator.clipboard.writeText(text).then(() => notify("已複製"), fail),
						compact: () => {
							notify("壓縮對話中…");
							controller.compact().then((done) => notify(done ? "已壓縮較早的對話" : "對話還短，沒有需要壓縮的內容"), fail);
						},
						reset: () => {
							if (window.confirm("開始新的上下文？模型將看不到之前的訊息，但紀錄會保留。")) controller.reset().catch(fail);
						},
						resetSandbox: runtime.hasSandbox
							? () => {
									if (!window.confirm("刪除這個對話的 sandbox 容器和裡面所有檔案？")) return;
									runtime.resetSandbox(controller.id).then(() => notify("已重置 sandbox"), fail);
								}
							: undefined,
					}}
				/>
			) : null}

			{confirm ? (
				<ConfirmDialog
					request={confirm.request}
					onAnswer={(approved) => {
						confirm.resolve(approved);
						setConfirm(undefined);
					}}
				/>
			) : null}
		</div>
	);
}
