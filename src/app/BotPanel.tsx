// Everything about the bot on screen, in a panel from the right (the drawer on the left is every bot): who it is,
// its schedules, its memory, its folder, and its conversation's context. Opened with the bar's ⋯ or by swiping the
// conversation to the left (SidePanel.tsx).
import type { ConversationId, ConversationView } from "@earendil-works/pi-durable";
import { type ReactNode, useEffect, useState } from "react";
import type { Bot } from "../agent/bots.ts";
import type { AgentRuntime, TriggerState } from "../agent/runtime.ts";
import type { ToolCost } from "../agent/runtime.ts";
import type { ToolsetState } from "../agent/toolsets.ts";
import { BotAvatar } from "./BotAvatar.tsx";
import { PrepareStatus, usePrepare } from "./HostsGroup.tsx";
import { BoxIcon, CopyIcon, FileIcon, LayersIcon, MemoryIcon, PencilIcon, RefreshIcon } from "./icons.tsx";
import { entryText } from "./Message.tsx";
import type { Prefs } from "./prefs.ts";
import { SidePanel } from "./SidePanel.tsx";
import { TriggerRow } from "./TriggerRow.tsx";
import { formatTokens, hasCacheActivity, tokensOf, type Usage } from "./usage.ts";

export interface PanelActions {
	edit: () => void;
	memory: () => void;
	compact: () => void;
	reset: () => void;
	workspace?: () => void;
	emptyFolder?: () => void;
	copy: (text: string) => void;
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

/** A toolset on one line: its name and a switch; one that needs setting up first says so. */
function ToolsetToggle({ toolset, onToggle }: { toolset: ToolsetState; onToggle: (id: string, enabled: boolean) => void }) {
	return (
		<label className={toolset.available ? "" : "unavailable"}>
			<span className="menu-text">{toolset.label}</span>
			{toolset.available ? null : <span className="index-value">未設定</span>}
			<input
				type="checkbox"
				disabled={!toolset.available}
				checked={toolset.available && toolset.enabled}
				onChange={(event) => onToggle(toolset.id, event.target.checked)}
			/>
		</label>
	);
}

/** Where the bot works; a container is prepared when chosen, with the build's progress here. */
function ComputerPicker({ runtime, bot, reload, onError }: { runtime: AgentRuntime; bot: Bot; reload: (id: ConversationId) => void; onError: (message: string) => void }) {
	const key = runtime.computerOf(bot.id).key;
	const [preparing, prepare] = usePrepare(key.endsWith(":container") ? runtime.hostOf(key) : undefined);
	useEffect(() => {
		// Already prepared this run, this answers at once; otherwise the progress shows while it builds.
		if (key.endsWith(":container")) void prepare();
		// Once per choice.
	}, [key]);
	return (
		<Section title="電腦">
			<select
				className="field"
				value={key}
				aria-label="電腦"
				onChange={(event) =>
					void runtime
						.setComputer(bot.id, event.target.value)
						.then(() => reload(bot.id))
						.catch((error: unknown) => onError(`切換電腦失敗：${error instanceof Error ? error.message : String(error)}`))
				}
			>
				{runtime.computers().map((computer) => (
					<option key={computer.key} value={computer.key}>
						{computer.key === "phone" ? computer.name : `${computer.name} · ${computer.mode}`}
					</option>
				))}
			</select>
			<PrepareStatus preparing={preparing} />
		</Section>
	);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="panel-section">
			<h3 className="strip-label">{title}</h3>
			{children}
		</section>
	);
}

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
	onError,
	onClose,
}: {
	open: boolean;
	bot: Bot | undefined;
	runtime: AgentRuntime;
	view: ConversationView | undefined;
	usage: Usage;
	/** The newest answer's prompt cache hit rate in percent (latestCacheHitRate). */
	cacheHitRate: number | undefined;
	context: { used: number; window: number };
	/** Where automatic compaction starts, in tokens; 0 for the model's own limit. */
	compactAt: number;
	prefs: Prefs;
	onPrefs: (change: Partial<Prefs>) => void;
	actions: PanelActions;
	onError: (message: string) => void;
	onClose: () => void;
}) {
	const [triggers, setTriggers] = useState<TriggerState>({ items: [], next: {} });
	const [memory, setMemory] = useState("");
	useEffect(() => runtime.subscribeTriggers(setTriggers), [runtime]);
	const botId = bot?.id;
	useEffect(() => (botId === undefined ? undefined : runtime.subscribeMemory({ kind: "bot", id: botId }, (next) => setMemory(next.text))), [runtime, botId]);
	const [toolsets, setToolsets] = useState<ToolsetState[]>([]);
	const [cost, setCost] = useState<ToolCost>({});
	const reload = (id: ConversationId) =>
		Promise.all([runtime.toolsets(id), runtime.toolCost(id)]).then(([nextToolsets, nextCost]) => {
			setToolsets(nextToolsets);
			setCost(nextCost);
		});
	useEffect(() => {
		if (botId === undefined || !open) return;
		let live = true;
		void Promise.all([runtime.toolsets(botId), runtime.toolCost(botId)]).then(([nextToolsets, nextCost]) => {
			if (!live) return;
			setToolsets(nextToolsets);
			setCost(nextCost);
		});
		return () => {
			live = false;
		};
	}, [runtime, botId, open]);
	if (!bot) return null;
	const services = toolsets.filter((toolset) => toolset.kind === "service");
	/** What a toolset's definitions add to each request, in characters. */
	const charsOf = (toolset: ToolsetState) => toolset.extensions.reduce((sum, name) => sum + (cost[name]?.offered ?? 0), 0);

	const toggle = (id: string, enabled: boolean) => {
		setToolsets((current) => current.map((toolset) => (toolset.id === id ? { ...toolset, enabled } : toolset)));
		runtime
			.setToolset(bot.id, id, enabled)
			.then(() => reload(bot.id))
			.catch((error: unknown) => onError(`工具設定失敗：${error instanceof Error ? error.message : String(error)}`));
	};

	const run = (action: () => void) => () => {
		onClose();
		action();
	};
	const mine = triggers.items.filter((item) => item.conversationId === bot.id);
	const memoryLines = memory.split("\n").filter((line) => line.trim()).slice(0, 3);
	const folder = runtime.folderOf(bot.id);
	const lastAnswer = [...(view?.entries ?? [])].reverse().find((entry) => entry.kind === "pi.assistant");
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

				<Section title="排程">
					<div className="menu">
						{mine.length === 0 ? (
							<div className="check-row">
								<span className="menu-text">還沒有排程</span>
							</div>
						) : (
							mine.map((trigger) => <TriggerRow key={trigger.id} trigger={trigger} next={triggers.next[trigger.id]} runtime={runtime} onError={onError} />)
						)}
					</div>
				</Section>

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

				{(["always", "on-demand"] as const).map((kind) => {
					const list = toolsets.filter((toolset) => toolset.kind === "builtin" && toolset.load === kind);
					if (list.length === 0) return null;
					const tokens = kind === "always" ? tokensOf(list.filter((toolset) => toolset.enabled).reduce((sum, toolset) => sum + charsOf(toolset), 0)) : 0;
					return (
						<Section key={kind} title={kind === "always" ? `常駐工具${tokens ? ` · 約 ${formatTokens(tokens)} tokens` : ""}` : "需要時載入的工具"}>
							<div className="menu toggles">
								{list.map((toolset) => (
									<ToolsetToggle key={toolset.id} toolset={toolset} onToggle={toggle} />
								))}
							</div>
						</Section>
					);
				})}

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

				{runtime.hasSandbox ? <ComputerPicker runtime={runtime} bot={bot} reload={reload} onError={onError} /> : null}
				{folder ? (
					<Section title="資料夾">
						<div className="menu">
							{actions.workspace ? <Item icon={<FileIcon size={18} />} label={folder.path} onClick={run(actions.workspace)} /> : null}
							{actions.emptyFolder ? (
								<Item icon={<BoxIcon size={18} />} label="清空資料夾" danger onClick={run(actions.emptyFolder)} />
							) : null}
						</div>
					</Section>
				) : null}

				<Section title="上下文">
					<div className="context-card">
						<div className="context-top">
							<span className="context-numbers">
								{formatTokens(context.used)} / {formatTokens(context.window)}
								<b>{percent.toFixed(0)}%</b>
							</span>
							<span className="context-note">{compactAt > 0 ? `${formatTokens(compactAt)} 時壓縮` : "接近上限時壓縮"}</span>
						</div>
						<div className="context-bar">
							<i style={{ width: `${Math.max(percent, 1.5)}%` }} />
						</div>
						<details className="stats-more">
							<summary>用量</summary>
							<dl className="stats">
							<div>
								<dt>輸入</dt>
								<dd>{formatTokens(usage.input)}</dd>
							</div>
							<div>
								<dt>輸出</dt>
								<dd>{formatTokens(usage.output)}</dd>
							</div>
							<div>
								<dt>快取讀</dt>
								<dd>{formatTokens(usage.cacheRead)}</dd>
							</div>
							<div>
								<dt>快取寫</dt>
								<dd>{formatTokens(usage.cacheWrite)}</dd>
							</div>
							{hasCacheActivity(usage) && cacheHitRate !== undefined ? (
								<div title="最新一次回答的提示中，從快取讀取的比例">
									<dt>快取命中</dt>
									<dd>{cacheHitRate.toFixed(1)}%</dd>
								</div>
							) : null}
							</dl>
						</details>
					</div>
					<div className="menu">
						<Item icon={<LayersIcon />} label="現在壓縮" onClick={run(actions.compact)} />
						<Item icon={<RefreshIcon />} label="新的上下文" hint="紀錄保留，模型看不到" onClick={run(actions.reset)} />
						<Item
							icon={<CopyIcon size={18} />}
							label="複製最後的回答"
							disabled={!lastAnswer}
							onClick={run(() => lastAnswer && actions.copy(entryText(lastAnswer)))}
						/>
					</div>
				</Section>

				<Section title="顯示">
					<div className="menu toggles">
						<label>
							<span className="menu-text">顯示思考過程</span>
							<input type="checkbox" checked={prefs.showThinking} onChange={(event) => onPrefs({ showThinking: event.target.checked })} />
						</label>
						<label>
							<span className="menu-text">預設展開工具輸出</span>
							<input type="checkbox" checked={prefs.expandTools} onChange={(event) => onPrefs({ expandTools: event.target.checked })} />
						</label>
					</div>
				</Section>
			</div>
		</SidePanel>
	);
}
