import type { ConversationId, ConversationSummary } from "../agent/runtime.ts";
import { ComposeIcon, GearIcon, TrashIcon } from "./icons.tsx";

const DAY = 24 * 60 * 60 * 1000;

function group(updatedAt: number, now: Date): string {
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	if (updatedAt >= startOfToday) return "今天";
	if (updatedAt >= startOfToday - DAY) return "昨天";
	if (updatedAt >= startOfToday - 6 * DAY) return "這週";
	return "更早";
}

function time(updatedAt: number, now: Date): string {
	const date = new Date(updatedAt);
	if (now.getTime() - updatedAt < 6 * DAY) return date.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false });
	return date.toLocaleDateString("zh-TW", { month: "numeric", day: "numeric" });
}

export function Drawer({
	conversations,
	currentId,
	status,
	onOpen,
	onCreate,
	onRemove,
	onSettings,
	onClose,
}: {
	conversations: ConversationSummary[];
	currentId: ConversationId | undefined;
	status: { label: string; on: boolean }[];
	onOpen: (id: ConversationId) => void;
	onCreate: () => void;
	onRemove: (item: ConversationSummary) => void;
	onSettings: () => void;
	onClose: () => void;
}) {
	const now = new Date();
	const groups = new Map<string, ConversationSummary[]>();
	for (const item of conversations) {
		const name = group(item.updatedAt, now);
		groups.set(name, [...(groups.get(name) ?? []), item]);
	}

	return (
		<div className="backdrop drawer-backdrop" onClick={onClose}>
			<nav className="drawer" onClick={(event) => event.stopPropagation()}>
				<div className="drawer-top">
					<span className="wordmark">pi</span>
					<button type="button" className="pill accent" onClick={onCreate}>
						<ComposeIcon /> 新對話
					</button>
				</div>
				<div className="drawer-list">
					{[...groups].map(([name, items]) => (
						<section key={name}>
							<h3>{name}</h3>
							{items.map((item) => (
								<div key={String(item.id)} className={`drawer-item${item.id === currentId ? " current" : ""}`}>
									<button type="button" className="drawer-open" onClick={() => onOpen(item.id)}>
										<span className="drawer-title">{item.title}</span>
										<span className="drawer-time">{time(item.updatedAt, now)}</span>
									</button>
									<button type="button" className="icon-button small" aria-label={`刪除 ${item.title}`} onClick={() => onRemove(item)}>
										<TrashIcon />
									</button>
								</div>
							))}
						</section>
					))}
				</div>
				<button type="button" className="drawer-settings" onClick={onSettings}>
					<GearIcon />
					<span>設定</span>
					<span className="drawer-status">
						{status.map((item) => (
							<span key={item.label} className={item.on ? "on" : ""}>
								{item.label}
							</span>
						))}
					</span>
				</button>
			</nav>
		</div>
	);
}
