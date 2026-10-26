import type { ConversationId, ConversationView } from "@earendil-works/pi-durable";
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import type { Bot } from "../agent/bots.ts";
import type { AgentRuntime } from "../agent/runtime.ts";
import type { TriggerState } from "../agent/triggers.ts";
import type { ToolsetState } from "../agent/toolsets.ts";
import type { Sandbox } from "../agent/sandbox/sandbox.ts";
import type { ConnectionStatus } from "../agent/sandbox/stream-connection.ts";
import { BotAvatar } from "./BotAvatar.tsx";
import { PrepareStatus, usePrepare } from "./HostsGroup.tsx";
import { BoxIcon, CopyIcon, LayersIcon, MemoryIcon, PencilIcon, RefreshIcon } from "./icons.tsx";
import { entryText } from "./Message.tsx";
import type { Prefs } from "./prefs.ts";
import { SidePanel } from "./SidePanel.tsx";
import { TriggerRow } from "./TriggerRow.tsx";
import { formatTokens, type Usage } from "./usage.ts";
import { messageOf } from "../promise.ts";
import { useBriefly } from "./briefly.ts";
import { native } from "../native.ts";

interface PanelActions {
	edit: () => void;
	memory: () => void;
	compact: () => Promise<boolean>;
	reset: () => void;
	emptyFolder?: () => Promise<boolean>;
	copy: (text: string) => Promise<void>;
}

function Item({ icon, label, hint, danger, disabled, onClick }: { icon: ReactNode; label: string; hint?: string; danger?: boolean; disabled?: boolean; onClick: () => void }) {
	return (
		<button type="button" className={danger ? "danger" : ""} disabled={disabled} onClick={onClick}>
			{icon}
			<span className="menu-text">
				{label}
				{hint ? <span className="menu-hint">{hint}</span> : null}
			</span>
		</button>
	);
}

function ToolsetToggle({ toolset, onToggle }: { toolset: ToolsetState; onToggle: (id: string, enabled: boolean) => void }) {
	return (
		<label className={toolset.available ? "" : "unavailable"}>
			<span className="menu-text">{toolset.label}</span>
			{toolset.available ? null : <span className="index-value">未設定</span>}
			<input
				type="checkbox"
				className="switch"
				disabled={!toolset.available}
				checked={toolset.available && toolset.enabled}
				onChange={(event) => onToggle(toolset.id, event.target.checked)}
			/>
		</label>
	);
}

function statusText(status: ConnectionStatus): { text: string; error: boolean } | undefined {
	switch (status.kind) {
		case "connecting":
			return { text: "連線中", error: false };
		case "connected":
			return { text: "已連線", error: false };
		case "reattaching":
			return { text: `${new Date(status.since).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" })} 起重新連線中`, error: false };
		case "lost":
			return { text: `${new Date(status.at).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" })} 連線中斷：${status.reason}`, error: true };
		default:
			return undefined;
	}
}

function HostStatus({ sandbox }: { sandbox: Sandbox }) {
	const status = useSyncExternalStore(
		(onChange) => sandbox.subscribe(onChange),
		() => sandbox.status,
	);
	const shown = statusText(status);
	if (!shown) return null;
	return <span className={shown.error ? "menu-hint error" : "menu-hint"}>{shown.text}</span>;
}

function ComputerPicker({ runtime, bot, reload, problem, onError }: { runtime: AgentRuntime; bot: Bot; reload: (id: ConversationId) => void; problem?: Problem; onError: (message: string) => void }) {
	const place = runtime.workplaces.at(String(bot.id));
	const key = place?.kind === "computer" ? place.computer.key : place?.kind === "missing" ? place.key : "phone";
	const container = place?.kind === "computer" && !place.sandbox.direct ? place.host : undefined;
	const [preparing, prepare] = usePrepare(container);
	const choose = async (next: string) => {
		await runtime.setComputer(bot.id, next);
		reload(bot.id);
		const chosen = runtime.workplaces.at(String(bot.id));
		if (chosen?.kind === "computer" && !chosen.sandbox.direct) await prepare(chosen.host);
	};
	return (
		<Section title="電腦" problem={problem}>
			<select className="field" value={key} aria-label="電腦" onChange={(event) => void choose(event.target.value).catch((error: unknown) => onError(`切換電腦失敗：${messageOf(error)}`))}>
				{place?.kind === "missing" ? (
					<option value={key} disabled>
						已移除的電腦
					</option>
				) : null}
				{runtime.workplaces.list().map((computer) => (
					<option key={computer.key} value={computer.key}>
						{computer.key === "phone" ? computer.name : `${computer.name} · ${computer.mode}`}
					</option>
				))}
			</select>
			{place?.kind === "computer" ? <HostStatus sandbox={place.sandbox} /> : null}
			<PrepareStatus preparing={preparing} />
		</Section>
	);
}

function Section({ title, problem, children }: { title: string; problem?: Problem; children: ReactNode }) {
	return (
		<section className="panel-section">
			<h3 className="strip-label">{title}</h3>
			{children}
			{problem?.section === title ? <div className="note error">{problem.text}</div> : null}
		</section>
	);
}

type Problem = { section: string; text: string };

export function BotPanel({
	open,
	bot,
	runtime,
	view,
	usage,
	cacheHitRate,
	context,
	compactAt,
	prefs,
	onPrefs,
	actions,
	onClose,
}: {
	open: boolean;
	bot: Bot | undefined;
	runtime: AgentRuntime;
	view: ConversationView | undefined;
	usage: Usage;
	cacheHitRate: number | undefined;
	context: { used: number; window: number };
	compactAt: number;
	prefs: Prefs;
	onPrefs: (change: Partial<Prefs>) => void;
	actions: PanelActions;
	onClose: () => void;
}) {
	const [problem, setProblem] = useState<Problem>();
	const [compacting, setCompacting] = useState(false);
	const [compacted, showCompacted] = useBriefly();
	const [copied, showCopied] = useBriefly();
	const [emptied, showEmptied] = useBriefly();
	useEffect(() => {
		if (!open) setProblem(undefined);
	}, [open]);
	const failIn = (section: string) => (error: unknown) => setProblem({ section, text: messageOf(error) });
	const [triggers, setTriggers] = useState<TriggerState>({ items: [], next: {} });
	const [memory, setMemory] = useState("");
	useEffect(() => runtime.triggers.subscribe(setTriggers), [runtime]);
	const botId = bot?.id;
	useEffect(() => (botId === undefined ? undefined : runtime.subscribeMemory({ kind: "bot", id: botId }, (next) => setMemory(next.text))), [runtime, botId]);
	const [toolsets, setToolsets] = useState<ToolsetState[]>([]);
	const reload = (id: ConversationId) => runtime.toolsets(id).then(setToolsets);
	useEffect(() => {
		if (botId === undefined || !open) return;
		let live = true;
		void runtime.toolsets(botId).then((next) => {
			if (live) setToolsets(next);
		});
		return () => {
			live = false;
		};
	}, [runtime, botId, open]);
	if (!bot) return null;
	const services = toolsets.filter((toolset) => toolset.kind === "service");

	const toggle = (id: string, enabled: boolean) => {
		setToolsets((current) => current.map((toolset) => (toolset.id === id ? { ...toolset, enabled } : toolset)));
		runtime
			.setToolset(bot.id, id, enabled)
			.then(() => reload(bot.id))
			.catch((error: unknown) => setProblem({ section: "工具", text: `工具設定失敗：${messageOf(error)}` }));
	};

	const run = (action: () => void) => () => {
		onClose();
		action();
	};
	const mine = triggers.items.filter((item) => item.conversationId === bot.id);
	const memoryLines = memory.split("\n").filter((line) => line.trim()).slice(0, 3);
	const lastAnswer = view?.entries.findLast((entry) => entry.kind === "pi.assistant");
	const percent = context.window ? Math.min(100, (context.used / context.window) * 100) : 0;

	return (
		<SidePanel side="right" open={open} onClose={onClose} label={`${bot.name} 的資訊`}>
			<div className="panel">
				<button type="button" className="panel-bot" onClick={run(actions.edit)}>
					<BotAvatar bot={bot} size={48} />
					<span className="panel-bot-text">
						<span className="panel-bot-name">
							{bot.name}
							<PencilIcon size={14} />
						</span>
						<span className="panel-bot-job">{bot.job || "一般助理"}</span>
					</span>
				</button>

				{native.has("Triggers") ? (
					<Section title="自動化" problem={problem}>
						<div className="menu">
							{mine.length === 0 ? (
								<div className="check-row">
									<span className="menu-text">還沒有自動化</span>
								</div>
							) : (
								mine.map((trigger) => <TriggerRow key={trigger.id} trigger={trigger} next={triggers.next[trigger.id]} runtime={runtime} onError={(text) => setProblem({ section: "自動化", text })} />)
							)}
						</div>
					</Section>
				) : null}

				<Section title="記憶">
					<div className="menu">
						<button type="button" className="panel-memory" onClick={run(actions.memory)}>
							<MemoryIcon />
							<span className="menu-text">
								{memoryLines.length > 0 ? memoryLines.map((line, index) => <span key={`${index}-${line}`} className="panel-memory-line">{line}</span>) : "還沒有記下什麼"}
							</span>
						</button>
					</div>
				</Section>

				<Section title="工具" problem={problem}>
					<div className="menu toggles">
						{toolsets
							.filter((toolset) => toolset.kind === "builtin")
							.map((toolset) => (
								<ToolsetToggle key={toolset.id} toolset={toolset} onToggle={toggle} />
							))}
					</div>
				</Section>

				<Section title="連接的服務">
					<div className="menu toggles">
						{services.length === 0 ? (
							<div className="check-row">
								<span className="menu-text">還沒有連接服務</span>
							</div>
						) : (
							services.map((toolset) => <ToolsetToggle key={toolset.id} toolset={toolset} onToggle={toggle} />)
						)}
					</div>
				</Section>

				{runtime.workplaces.offers(String(bot.id)) ? <ComputerPicker runtime={runtime} bot={bot} reload={reload} problem={problem} onError={(text) => setProblem({ section: "電腦", text })} /> : null}
				{actions.emptyFolder ? (
					<Section title="資料夾" problem={problem}>
						<div className="menu">
							<Item
								icon={<BoxIcon size={18} />}
								label="清空資料夾"
								hint={emptied}
								danger
								onClick={() => void actions.emptyFolder?.().then((done) => done && showEmptied("已清空"), failIn("資料夾"))}
							/>
						</div>
					</Section>
				) : null}

				<Section title="上下文" problem={problem}>
					<div className="context-card">
						<div className="context-top">
							<span className="context-numbers">
								{formatTokens(context.used)} / {formatTokens(context.window)}
								<b>{percent.toFixed(0)}%</b>
							</span>
							{compactAt > 0 ? <span className="context-note">{formatTokens(compactAt)} 時壓縮</span> : null}
						</div>
						<div className="context-bar">
							<i style={{ width: `${Math.max(percent, 1.5)}%` }} />
						</div>
						<details className="stats-more">
							<summary>用量</summary>
							<dl className="stats">
								{(
									[
										["輸入", usage.input],
										["輸出", usage.output],
										["快取讀", usage.cacheRead],
										["快取寫", usage.cacheWrite],
									] as const
								).map(([label, value]) => (
									<div key={label}>
										<dt>{label}</dt>
										<dd>{formatTokens(value)}</dd>
									</div>
								))}
								{(usage.cacheRead > 0 || usage.cacheWrite > 0) && cacheHitRate !== undefined ? (
									<div title="最新一次回答的提示中，從快取讀取的比例">
										<dt>快取命中</dt>
										<dd>{cacheHitRate.toFixed(1)}%</dd>
									</div>
								) : null}
							</dl>
						</details>
					</div>
					<div className="menu">
						<Item
							icon={<LayersIcon />}
							label="現在壓縮"
							hint={compacting ? "壓縮中…" : compacted}
							disabled={compacting}
							onClick={() => {
								setCompacting(true);
								void actions
									.compact()
									.then((done) => showCompacted(done ? "已把較早的對話壓縮成摘要" : "對話還短，不需要壓縮"), failIn("上下文"))
									.finally(() => setCompacting(false));
							}}
						/>
						<Item icon={<RefreshIcon />} label="新的上下文" hint="紀錄保留，模型看不到" onClick={run(actions.reset)} />
						<Item
							icon={<CopyIcon size={18} />}
							label={copied ?? "複製最後的回答"}
							disabled={!lastAnswer}
							onClick={() => lastAnswer && void actions.copy(entryText(lastAnswer)).then(() => showCopied("已複製"), failIn("上下文"))}
						/>
					</div>
				</Section>

				<Section title="顯示">
					<div className="menu toggles">
						<label>
							<span className="menu-text">顯示思考過程</span>
							<input type="checkbox" className="switch" checked={prefs.showThinking} onChange={(event) => onPrefs({ showThinking: event.target.checked })} />
						</label>
						<label>
							<span className="menu-text">預設展開工具輸出</span>
							<input type="checkbox" className="switch" checked={prefs.expandTools} onChange={(event) => onPrefs({ expandTools: event.target.checked })} />
						</label>
					</div>
				</Section>
			</div>
		</SidePanel>
	);
}
