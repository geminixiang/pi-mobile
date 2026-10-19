import { useRef, useState } from "react";
import type { ConversationId, ConversationSummary } from "../agent/runtime.ts";
import { ComposeIcon, GearIcon, SearchIcon, TrashIcon } from "./icons.tsx";
import { PiMark } from "./PiMark.tsx";
import { Layer } from "./Sheet.tsx";

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
	open,
	busy,
	conversations,
	currentId,
	status,
	onOpen,
	onCreate,
	onRemove,
	onSettings,
	onClose,
}: {
	open: boolean;
	busy: boolean;
	conversations: ConversationSummary[];
	currentId: ConversationId | undefined;
	status: { label: string; on: boolean }[];
	onOpen: (id: ConversationId) => void;
	onCreate: () => void;
	onRemove: (item: ConversationSummary) => void;
	onSettings: () => void;
	onClose: () => void;
}) {
	const [query, setQuery] = useState("");
	const swipe = useRef<number>(undefined);
	const now = new Date();
	const groups = new Map<string, ConversationSummary[]>();
	for (const item of conversations) {
		if (query && !item.title.toLowerCase().includes(query.toLowerCase())) continue;
		const name = group(item.updatedAt, now);
		groups.set(name, [...(groups.get(name) ?? []), item]);
	}

	return (
		<Layer open={open} kind="drawer" onClose={onClose} label="對話列表">
			<div
				className="drawer"
				onTouchStart={(event) => {
					swipe.current = event.touches[0]?.clientX;
				}}
				onTouchMove={(event) => {
					const x = event.touches[0]?.clientX;
					if (swipe.current !== undefined && x !== undefined && swipe.current - x > 64) {
						swipe.current = undefined;
						onClose();
					}
				}}
			>
				<div className="drawer-top">
					<span className="brand">
						<PiMark size={20} live={busy} />
						<span className="brand-name">pi mobile</span>
					</span>
				</div>
				<button type="button" className="btn wide" onClick={onCreate}>
					<ComposeIcon size={16} /> 新對話
				</button>
				<label className="field-icon">
					<SearchIcon />
					<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜尋對話" />
				</label>
				<div className="drawer-list">
					{[...groups].map(([name, items]) => (
						<section key={name}>
							<h3 className="strip-label">{name}</h3>
							{items.map((item) => (
								<div key={String(item.id)} className={`drawer-item${item.id === currentId ? " current" : ""}`}>
									<button type="button" className="drawer-open" onClick={() => onOpen(item.id)}>
										<span className="drawer-title">{item.title}</span>
										<span className="drawer-time">{time(item.updatedAt, now)}</span>
									</button>
									<button type="button" className="icon-button small" aria-label={`刪除 ${item.title}`} onClick={() => onRemove(item)}>
										<TrashIcon size={16} />
									</button>
								</div>
							))}
						</section>
					))}
					{groups.size === 0 ? <p className="drawer-none">{query ? "找不到符合的對話" : "還沒有對話"}</p> : null}
				</div>
				<button type="button" className="drawer-settings" onClick={onSettings}>
					<GearIcon />
					<span className="drawer-settings-text">設定</span>
					<span className="drawer-status">
						{status.map((item) => (
							<span key={item.label} className={item.on ? "on" : ""}>
								{item.label}
							</span>
						))}
					</span>
				</button>
			</div>
		</Layer>
	);
}
