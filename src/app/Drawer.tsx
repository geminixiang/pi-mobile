import type { ReactNode } from "react";
import { GearIcon, PiMark } from "pi-mobile-ui/elements";
import { BotList, type BotListProps } from "./bots/BotList.tsx";
import type { Source } from "pi-mobile-ui/store";
import { type Place, type SidePage, SidePanel } from "./SidePanel.tsx";

export function Drawer({
	place,
	page,
	busy,
	list,
	status,
	onSettings,
	onClose,
}: {
	place: Source<Place>;
	page: SidePage;
	busy: boolean;
	list: BotListProps;
	status: { label: string; icon: ReactNode; on: boolean }[];
	onSettings: () => void;
	onClose: () => void;
}) {
	return (
		<SidePanel side="left" place={place} page={page} onClose={onClose} label="Bot 列表">
			<div className="drawer">
				<div className="drawer-top">
					<span className="brand">
						<PiMark size={20} />
						<span className="brand-name">pi mobile</span>
						{busy ? <i className="busy-dot" aria-label="執行中" /> : null}
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
