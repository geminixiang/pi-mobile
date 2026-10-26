import type { ReactNode } from "react";
import type { Bot } from "../agent/bots.ts";
import type { ConversationId } from "../agent/runtime.ts";
import { GearIcon, MoreIcon, PlusIcon, TriggerIcon, type TriggerSymbol } from "./icons.tsx";
import type { Trigger, When } from "../agent/triggers.ts";
import { symbolsOf } from "./triggerSymbol.ts";
import { BotAvatar } from "./BotAvatar.tsx";
import { PiMark } from "./PiMark.tsx";
import { SidePanel } from "./SidePanel.tsx";
import { DAY, startOfToday } from "../agent/tools/common.ts";

const SHOWN_SYMBOLS = 3;
const CLOCK = new Intl.DateTimeFormat("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false });
const MONTH_DAY = new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric" });

const SYMBOL_NAMES: Record<TriggerSymbol, string> = {
	clock: "時間",
	headphones: "耳機",
	bell: "通知",
	pin: "地點",
	wifi: "Wi‑Fi",
	charging: "充電",
	battery: "電量",
	unlock: "解鎖",
	image: "照片",
	car: "坐車",
	globe: "時區",
	bluetooth: "藍牙",
	walk: "走路",
	bike: "騎車",
	still: "靜止",
};

function BotAutomations({ whens }: { whens: readonly When[] }) {
	const symbols = symbolsOf(whens);
	if (symbols.length === 0) return null;
	const hidden = symbols.length - SHOWN_SYMBOLS;
	return (
		<span className="bot-automations" aria-label={`自動化：${symbols.map((symbol) => SYMBOL_NAMES[symbol]).join("、")}`}>
			{symbols.slice(0, SHOWN_SYMBOLS).map((symbol) => (
				<TriggerIcon key={symbol} symbol={symbol} size={13} />
			))}
			{hidden > 0 ? <span className="bot-automations-more">+{hidden}</span> : null}
		</span>
	);
}

function time(updatedAt: number, today: number): string {
	if (updatedAt >= today) return CLOCK.format(updatedAt);
	if (updatedAt >= today - DAY) return "昨天";
	return MONTH_DAY.format(updatedAt);
}

export function Drawer({
	open,
	busy,
	bots,
	automations,
	currentId,
	status,
	onOpen,
	onCreate,
	onEdit,
	running,
	onSettings,
	onClose,
}: {
	open: boolean;
	busy: boolean;
	bots: Bot[];
	automations: readonly Trigger[];
	currentId: ConversationId | undefined;
	status: { label: string; icon: ReactNode; on: boolean }[];
	onOpen: (id: ConversationId) => void;
	onCreate: () => void;
	onEdit: (bot: Bot) => void;
	running: ReadonlySet<ConversationId>;
	onSettings: () => void;
	onClose: () => void;
}) {
	const today = startOfToday();
	return (
		<SidePanel side="left" open={open} onClose={onClose} label="Bot 列表">
			<div className="drawer">
				<div className="drawer-top">
					<span className="brand">
						<PiMark size={20} live={busy} />
						<span className="brand-name">pi mobile</span>
					</span>
				</div>
				<div className="drawer-list">
					{bots.map((bot) => (
						<div
							key={String(bot.id)}
							className={`drawer-item bot-item${bot.id === currentId ? " current" : ""}`}
							onContextMenu={(event) => {
								event.preventDefault();
								onEdit(bot);
							}}
						>
							<button type="button" className="drawer-open" onClick={() => onOpen(bot.id)}>
								<BotAvatar bot={bot} size={36} />
								<span className="bot-text">
									<span className="drawer-title">
										{running.has(bot.id) ? <span className="drawer-running" aria-label="執行中" /> : null}
										<span className="bot-name">{bot.name}</span>
										<BotAutomations whens={automations.filter((item) => item.enabled && item.conversationId === bot.id).map((item) => item.when)} />
									</span>
									<span className="bot-job">{bot.job.split("\n")[0] || "一般助理"}</span>
								</span>
								<span className="drawer-time">{time(bot.updatedAt, today)}</span>
							</button>
							<button type="button" className="icon-button small" aria-label={`${bot.name} 的設定`} onClick={() => onEdit(bot)}>
								<MoreIcon />
							</button>
						</div>
					))}
					<button type="button" className="drawer-add" onClick={onCreate}>
						<PlusIcon size={16} />
						<span>新增 Bot</span>
					</button>
				</div>
				<button type="button" className="drawer-settings" onClick={onSettings}>
					<GearIcon />
					<span className="drawer-settings-text">設定</span>
					<span className="drawer-status">
						{status.map((item) => (
							<span key={item.label} className={item.on ? "on" : ""} role="img" aria-label={`${item.label}：${item.on ? "已連接" : "未設定"}`}>
								{item.icon}
							</span>
						))}
					</span>
				</button>
			</div>
		</SidePanel>
	);
}
