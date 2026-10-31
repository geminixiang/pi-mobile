import { useState } from "react";
import type { Bot } from "../agent/bots.ts";
import type { AgentRuntime } from "../agent/runtime.ts";
import type { LastRun, Trigger } from "./runs.ts";
import { messageOf } from "../promise.ts";
import { TriggerIcon } from "../app/icons.tsx";
import { describeTime, describeWhen, isEvent, triggerSymbol } from "./when.ts";
import { GUARD_IDS, GUARDS, type GuardId } from "../agent/guards.ts";

function GuardChips({ name, guards, onChange }: { name: string; guards: GuardId[]; onChange: (guards: GuardId[]) => void }) {
	const chosen = new Set(guards);
	return (
		<span className="guard-chips" role="group" aria-label={`${name} 的防線`}>
			{GUARD_IDS.map((guard) => (
				<label key={guard} className="chip">
					<input
						type="checkbox"
						checked={chosen.has(guard)}
						onChange={(event) => onChange(GUARD_IDS.filter((id) => (id === guard ? event.target.checked : chosen.has(id))))}
					/>
					{GUARDS[guard].short}
				</label>
			))}
		</span>
	);
}

const DELIVERY_LABEL = { live: "背景執行", later: "打開 pi 後執行", manual: "手動執行" };

const percent = (probability: number) => `${Math.round(probability * 100)}%`;

function lastRun(last: LastRun): string {
	if (last.outcome === "failed") return last.error;
	const probability = last.confidence?.kind === "judged" ? last.confidence.probability : undefined;
	if (last.outcome === "skipped") return `略過：${last.reason}${probability !== undefined ? `（${percent(probability)}）` : ""}`;
	const judged = probability !== undefined ? ` · 判斷 ${percent(probability)}` : last.confidence ? " · 沒有判斷" : "";
	return `${DELIVERY_LABEL[last.delivery]}${judged}`;
}

export function TriggerRow({
	trigger,
	next,
	bot,
	runtime,
	onError,
}: {
	trigger: Trigger;
	next: number | undefined;
	bot?: Bot | "deleted";
	runtime: AgentRuntime;
	onError: (message: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const act = (action: Promise<unknown>) => action.catch((failure: unknown) => onError(messageOf(failure)));
	const last = trigger.last;
	const guards = trigger.guards ?? [];
	return (
		<div className={`check-row trigger-row${trigger.state === "paused" ? " paused" : ""}`}>
			<span className="trigger-symbol">
				<TriggerIcon symbol={triggerSymbol(trigger.when)} />
			</span>
			<span className="menu-text">
				<button type="button" className="menu-text" aria-expanded={open} onClick={() => setOpen(!open)}>
					{trigger.kind === "followup" ? `稍後再看：${trigger.name}` : trigger.name}
					<span className="menu-hint">
						{bot ? `${bot === "deleted" ? "已刪除的 Bot" : bot.name} · ` : ""}
						{describeWhen(trigger.when)}
						{trigger.state !== "paused" && next ? ` · 下次 ${describeTime(next)}` : ""}
					</span>
					{trigger.onlyIf ? <span className="menu-hint">只在：{trigger.onlyIf}</span> : null}
					{!open && guards.length > 0 ? <span className="menu-hint">{guards.map((guard) => GUARDS[guard].short).join("、")}</span> : null}
					{last ? (
						<span className={`menu-hint${last.outcome === "failed" ? " error" : ""}`}>
							上次 {describeTime(last.at)} {lastRun(last)}
						</span>
					) : null}
				</button>
				{open ? (
					<>
						{isEvent(trigger.when) ? (
							<GuardChips name={trigger.name} guards={guards} onChange={(chosen) => void act(runtime.triggers.setGuards(trigger.id, chosen))} />
						) : null}
						<span className="trigger-actions">
							<button type="button" onClick={() => void act(runtime.triggers.run(trigger.id, "manual"))}>
								立即執行
							</button>
							<button type="button" className="danger" onClick={() => void act(runtime.triggers.delete(trigger.id))}>
								刪除
							</button>
						</span>
					</>
				) : null}
			</span>
			<input
				type="checkbox"
				className="switch"
				aria-label={trigger.name}
				checked={trigger.state !== "paused"}
				onChange={(event) => void act(runtime.triggers.setPaused(trigger.id, !event.target.checked))}
			/>
		</div>
	);
}
