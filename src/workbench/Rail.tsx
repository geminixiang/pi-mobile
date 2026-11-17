import { BotList, type BotListProps } from "../app/bots/BotList.tsx";
import { GearIcon } from "../ui/icons.tsx";
import { PiMark } from "../ui/PiMark.tsx";

export function Rail({ busy, list, onSettings }: { busy: boolean; list: BotListProps; onSettings: () => void }) {
	return (
		<nav className="rail" aria-label="Bot 列表">
			<span className="rail-logo">
				<PiMark size={26} live={busy} />
			</span>
			<BotList look="rail" {...list} />
			<button type="button" className="rail-settings" onClick={onSettings} aria-label="設定">
				<GearIcon />
			</button>
		</nav>
	);
}
