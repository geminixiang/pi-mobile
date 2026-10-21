import type { ReactNode } from "react";
import type { Bot } from "../agent/bots.ts";
import type { ConversationId } from "../agent/runtime.ts";
import { GearIcon, MemoryIcon, MoreIcon, PlusIcon } from "./icons.tsx";
import { BotAvatar } from "./BotAvatar.tsx";
import { PiMark } from "./PiMark.tsx";
import { Layer } from "./Sheet.tsx";

const DAY = 24 * 60 * 60 * 1000;

function time(updatedAt: number, now: Date): string {
	const date = new Date(updatedAt);
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	if (updatedAt >= startOfToday) return date.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false });
	if (updatedAt >= startOfToday - DAY) return "昨天";
	return date.toLocaleDateString("zh-TW", { month: "numeric", day: "numeric" });
}

/** The bots, each one long conversation, most recently talked to first. */
export function Drawer({
	open,
	busy,
	bots,
	currentId,
	status,
	onOpen,
	onCreate,
	onEdit,
	running,
	onSettings,
	onMemory,
	onClose,
}: {
	open: boolean;
	busy: boolean;
	bots: Bot[];
	currentId: ConversationId | undefined;
	/** Connected services, shown as marks: full color when set up, dimmed when not. */
	status: { label: string; icon: ReactNode; on: boolean }[];
	onOpen: (id: ConversationId) => void;
	onCreate: () => void;
	/** The bot's settings, from the row's menu or a long press. */
	onEdit: (bot: Bot) => void;
	/** Bots with a run in progress. */
	running: ReadonlySet<ConversationId>;
	onSettings: () => void;
	/** Opens the global MEMORY.md, what every bot knows about the user. */
	onMemory: () => void;
	onClose: () => void;
}) {
	const now = new Date();
	return (
		<Layer open={open} kind="drawer" onClose={onClose} label="Bot 列表">
			<div
				className="drawer"
			>
				<div className="drawer-top">
					<span className="brand">
						<PiMark size={20} live={busy} />
						<span className="brand-name">pi mobile</span>
					</span>
				</div>
				<div className="drawer-list">
					<h3 className="strip-label">Bots</h3>
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
										{bot.name}
									</span>
									<span className="bot-job">{bot.job.split("\n")[0] || "一般助理"}</span>
								</span>
								<span className="drawer-time">{time(bot.updatedAt, now)}</span>
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
				<button type="button" className="drawer-settings drawer-memory" onClick={onMemory}>
					<MemoryIcon />
					<span className="drawer-settings-text">全域記憶</span>
					<span className="drawer-hint">MEMORY.md</span>
				</button>
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
		</Layer>
	);
}
