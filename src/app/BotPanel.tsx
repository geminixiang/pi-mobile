// Everything about the bot on screen, in a panel from the right (the drawer on the left is every bot): who it is,
// its schedules, its memory, its folder, and its conversation's context. Opened with the bar's ⋯ or by swiping the
// conversation to the left (sideSwipe.ts).
import type { ConversationView } from "@earendil-works/pi-durable";
import { type ReactNode, useEffect, useState } from "react";
import type { Bot } from "../agent/bots.ts";
import type { AgentRuntime, TriggerState } from "../agent/runtime.ts";
import { BotAvatar } from "./BotAvatar.tsx";
import { BoxIcon, CopyIcon, FileIcon, LayersIcon, MemoryIcon, PencilIcon, RefreshIcon } from "./icons.tsx";
import { entryText } from "./Message.tsx";
import type { Prefs } from "./prefs.ts";
import { SidePanel } from "./SidePanel.tsx";
import { TriggerRow } from "./TriggerRow.tsx";
import { formatTokens, hasCacheActivity, type Usage } from "./usage.ts";

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
	drag,
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
	/** Where a swipe holds it, 0 to 1, while dragged. */
	drag: number | undefined;
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
	if (!bot) return null;

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
		<SidePanel side="right" open={open} drag={drag} onClose={onClose} label={`${bot.name} 的資訊`}>
			<div className="panel">
				<button type="button" className="panel-bot" onClick={run(actions.edit)}>
					<BotAvatar bot={bot} size={48} />
					<span className="panel-bot-text">
						<span className="panel-bot-name">
							{bot.name}
							<PencilIcon size={14} />
						</span>
						<span className="panel-bot-job">{bot.job || "一般助理，沒有寫工作說明"}</span>
					</span>
				</button>

				<Section title="排程">
					<div className="menu">
						{mine.length === 0 ? (
							<div className="check-row">
								<span className="menu-text">
									還沒有排程
									<span className="menu-hint">跟{bot.name}說「每天早上 8 點給我簡報」或「戴上耳機時跟我報告」。</span>
								</span>
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
								<span className="menu-hint">只有{bot.name}看得到；所有 Bot 都知道的事放在全域記憶</span>
							</span>
						</button>
					</div>
				</Section>

				{folder ? (
					<Section title="資料夾">
						<div className="menu">
							{actions.workspace ? <Item icon={<FileIcon size={18} />} label={folder.path} hint={`${folder.where} · 檔案、git 變更和 commit`} onClick={run(actions.workspace)} /> : null}
							{actions.emptyFolder ? (
								<Item icon={<BoxIcon size={18} />} label="清空資料夾" hint="刪除這個 Bot 在 sandbox 裡的檔案" danger onClick={run(actions.emptyFolder)} />
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
						</div>
						<div className="context-bar">
							<i style={{ width: `${Math.max(percent, 1.5)}%` }} />
						</div>
						<p className="context-note">
							{compactAt > 0 ? `超過 ${formatTokens(compactAt)} 時自動壓縮` : "到模型上限前自動壓縮"}（設定 › 自動壓縮）
						</p>
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
					</div>
					<div className="menu">
						<Item icon={<LayersIcon />} label="現在壓縮" hint="把較早的內容摘要起來，騰出上下文" onClick={run(actions.compact)} />
						<Item icon={<RefreshIcon />} label="新的上下文" hint="模型看不到之前的訊息，紀錄保留" onClick={run(actions.reset)} />
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
