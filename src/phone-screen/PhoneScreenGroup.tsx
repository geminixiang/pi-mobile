import { resumed } from "../ui/resume.ts";
import { RowList } from "../ui/RowList.tsx";
import { StateRow } from "../ui/StateRow.tsx";
import { backgroundSetup } from "./background.ts";
import { BackgroundSetup } from "./BackgroundSetup.tsx";
import { PhoneScreen } from "./plugin.ts";
import { useSubscribed } from "../ui/subscribed.ts";

export function PhoneScreenGroup() {
	const allowed = useSubscribed<boolean | undefined>(undefined, resumed(() => PhoneScreen.status().then((status) => status.allowed)), []);
	if (allowed === undefined) return null;
	return (
		<RowList title="代你操作 App">
			<StateRow label="無障礙服務" hint={allowed ? "背景時也能開 App" : "開關是灰的：到 App 資訊 › ⋮ › 允許受限制的設定"} on={allowed} onClick={() => void PhoneScreen.openSettings()} />
			{allowed ? null : (
				<button type="button" className="row-add" onClick={() => void PhoneScreen.openAppInfo()}>
					打開 App 資訊
				</button>
			)}
			{backgroundSetup.available() ? <BackgroundSetup allowed={allowed} /> : null}
		</RowList>
	);
}
