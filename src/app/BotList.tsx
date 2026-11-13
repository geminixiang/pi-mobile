import type { Bot } from "../agent/bots.ts";
import type { ConversationId } from "../agent/runtime.ts";
import { MoreIcon, PlusIcon, TriggerIcon } from "./icons.tsx";
import type { TriggerSymbol } from "../triggers/when.ts";
import type { Trigger } from "../triggers/runs.ts";
import type { When } from "../triggers/plugin.ts";
import { triggerSymbol } from "../triggers/when.ts";
import { BotAvatar } from "./BotAvatar.tsx";
import { DAY, startOfToday } from "../time.ts";
import { CLOCK } from "./clock.ts";

const SHOWN_SYMBOLS = 3;
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
	const symbols = [...new Set(whens.map((when) => triggerSymbol(when)))];
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

export type BotListProps = {
	bots: readonly Bot[];
	automations: readonly Trigger[];
	currentId: ConversationId | undefined;
	running: ReadonlySet<ConversationId>;
	onOpen: (id: ConversationId) => void;
	onCreate: () => void;
	onEdit: (bot: Bot) => void;
};

export function BotList({ look, bots, automations, currentId, running, onOpen, onCreate, onEdit }: BotListProps & { look: "rows" | "rail" }) {
	if (look === "rail") {
		return (
			<div className="rail-list">
				{bots.map((bot) => (
					<button type="button" key={String(bot.id)} className={`rail-bot${bot.id === currentId ? " current" : ""}`} onClick={() => onOpen(bot.id)}>
						<BotAvatar bot={bot} size={44} />
						<span className="rail-name">{bot.name}</span>
						{running.has(bot.id) ? <span className="drawer-running rail-running" aria-label="執行中" /> : null}
					</button>
				))}
				<button type="button" className="rail-add" onClick={onCreate} aria-label="新增 Bot">
					<PlusIcon size={18} />
				</button>
			</div>
		);
	}
	const today = startOfToday();
	return (
		<div className="drawer-list">
			{bots.map((bot) => (
				<div key={String(bot.id)} className={`drawer-item${bot.id === currentId ? " current" : ""}`}>
					<button type="button" className="drawer-open" onClick={() => onOpen(bot.id)}>
						<BotAvatar bot={bot} size={36} />
						<span className="bot-text">
							<span className="drawer-title">
								{running.has(bot.id) ? <span className="drawer-running" aria-label="執行中" /> : null}
								<span className="bot-name">{bot.name}</span>
								<BotAutomations whens={automations.filter((item) => item.state !== "paused" && item.conversationId === bot.id).map((item) => item.when)} />
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
			<button type="button" className="list-add" onClick={onCreate}>
				<PlusIcon size={16} />
				<span>新增 Bot</span>
			</button>
		</div>
	);
}
