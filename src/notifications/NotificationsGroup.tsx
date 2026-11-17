import { useBriefly } from "../ui/briefly.ts";
import { RowList } from "../ui/RowList.tsx";
import { StateRow } from "../ui/StateRow.tsx";
import { Notifications } from "./plugin.ts";

export function NotificationsGroup({ allowed }: { allowed: boolean | undefined }) {
	if (allowed === undefined) return null;
	return (
		<RowList title="通知">
			<StateRow label="讀取通知" hint={allowed ? "保留 30 天" : "讓 Bot 看到收到的通知"} on={allowed} onClick={() => void Notifications.openSettings()} />
		</RowList>
	);
}

export function ClearNotifications() {
	const [cleared, showCleared] = useBriefly();
	return (
		<button type="button" className="danger-verb" disabled={Boolean(cleared)} onClick={() => void Notifications.clear().then(() => showCleared("已清除"))}>
			{cleared ?? "清除通知紀錄"}
		</button>
	);
}
