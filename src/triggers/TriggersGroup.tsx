import { useState } from "react";
import type { Bot } from "../agent/bots.ts";
import { native } from "../native.ts";
import { messageOf } from "pi-mobile-base/promise";
import { onResume, resumed } from "pi-mobile-ui/platform";
import { RowList, StateRow } from "pi-mobile-ui/elements";
import { useStore, useSubscribed } from "pi-mobile-ui/store";
import { Triggers } from "./plugin.ts";
import { NO_TRIGGERS, type TriggerRuns, type TriggerState } from "./runs.ts";
import { TriggerList } from "./TriggerList.tsx";

export function TriggersGroup({ runs, watchBots }: { runs: TriggerRuns; watchBots: (listener: (bots: Bot[]) => void) => () => void }) {
	const state = useSubscribed<TriggerState>(
		NO_TRIGGERS,
		(listener) => {
			const stopListening = runs.subscribe(listener);
			const stopSyncing = native.has("Triggers") ? onResume(() => void runs.sync()) : undefined;
			return () => {
				stopListening();
				stopSyncing?.();
			};
		},
		[runs],
	);
	const bots = useSubscribed<Bot[]>([], watchBots, [runs]);
	const [error, setError] = useState("");
	const [{ bluetooth, overlay }, setAllowed] = useStore<{ bluetooth?: boolean; overlay?: boolean }>({}, resumed(native.has("Triggers") ? () => Triggers.status() : undefined), []);
	if (!native.has("Triggers")) return null;
	const headphones = state.items.some((item) => item.state !== "paused" && (item.when.kind === "headphones" || item.when.kind === "bluetooth"));

	const asks = (state.items.length > 0 && overlay === false) || (headphones && bluetooth === false);

	return (
		<>
			{state.items.length === 0 ? (
				<RowList title="自動化">
					<p className="row-empty">還沒有自動化，跟 Bot 說就會建立</p>
				</RowList>
			) : (
				<div className="trigger-page">
					<TriggerList triggers={state.items} next={state.next} bots={bots} runs={runs} onError={setError} />
				</div>
			)}
			{asks ? (
				<RowList title="要開的權限">
					{state.items.length > 0 && overlay === false ? <StateRow label="滑掉 pi 也照跑" hint="沒開時要點通知才會跑" on={false} onClick={() => void Triggers.requestOverlay()} /> : null}
					{headphones && bluetooth === false ? (
						<StateRow
							label="偵測藍牙耳機"
							on={false}
							onClick={() => void Triggers.requestBluetooth().then(({ granted }) => setAllowed({ bluetooth: granted, overlay }), (failure: unknown) => setError(messageOf(failure)))}
						/>
					) : null}
				</RowList>
			) : null}
			{error ? <div className="banner error">{error}</div> : null}
		</>
	);
}
