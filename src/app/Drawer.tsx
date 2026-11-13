import type { ReactNode } from "react";
import { GearIcon } from "./icons.tsx";
import { BotList, type BotListProps } from "./BotList.tsx";
import { PiMark } from "./PiMark.tsx";
import { type SidePage, SidePanel } from "./SidePanel.tsx";

export function Drawer({
	open,
	page,
	busy,
	list,
	status,
	onSettings,
	onClose,
}: {
	open: boolean;
	page: SidePage;
	busy: boolean;
	list: BotListProps;
	status: { label: string; icon: ReactNode; on: boolean }[];
	onSettings: () => void;
	onClose: () => void;
}) {
	return (
		<SidePanel side="left" open={open} page={page} onClose={onClose} label="Bot 列表">
			<div className="drawer">
				<div className="drawer-top">
					<span className="brand">
						<PiMark size={20} live={busy} />
						<span className="brand-name">pi mobile</span>
					</span>
				</div>
				<BotList look="rows" {...list} />
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
