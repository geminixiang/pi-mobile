import type { Bot } from "../agent/bots.ts";
import type { AgentRuntime } from "../agent/runtime.ts";
import { describeTime, describeWhen, type Trigger } from "../agent/triggers.ts";
import { messageOf } from "../promise.ts";
import { TriggerIcon } from "./icons.tsx";
import { triggerSymbol } from "./triggerSymbol.ts";

const DELIVERY_LABEL = { live: "背景執行", later: "打開 pi 後執行", manual: "手動執行" };

const percent = (probability: number) => `${Math.round(probability * 100)}%`;

function lastRun(last: NonNullable<Trigger["last"]>): string {
	if (last.error) return last.error;
	if (last.skipped) return `略過（${percent(last.judged ?? 0)}）`;
	const judged = last.judged !== undefined ? ` · 判斷 ${percent(last.judged)}` : last.unjudged ? " · 沒有判斷" : "";
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
	const act = (action: Promise<unknown>) => action.catch((failure: unknown) => onError(messageOf(failure)));
	const last = trigger.last;
	return (
		<div className={`check-row trigger-row${trigger.enabled ? "" : " paused"}`}>
			<span className="trigger-symbol">
				<TriggerIcon symbol={triggerSymbol(trigger.when)} />
			</span>
			<span className="menu-text">
				{trigger.kind === "followup" ? `稍後再看：${trigger.name}` : trigger.name}
				<span className="menu-hint">
					{bot ? `${bot === "deleted" ? "已刪除的 Bot" : bot.name} · ` : ""}
					{describeWhen(trigger.when)}
					{trigger.enabled && next ? ` · 下次 ${describeTime(next)}` : ""}
				</span>
				{trigger.onlyIf ? <span className="menu-hint">只在：{trigger.onlyIf}</span> : null}
				{last ? (
					<span className={`menu-hint${last.error ? " error" : ""}`}>
						上次 {describeTime(last.at)} {lastRun(last)}
					</span>
				) : null}
				<span className="trigger-actions">
					<button type="button" onClick={() => void act(runtime.triggers.run(trigger.id, "manual"))}>
						立即執行
					</button>
					<button type="button" className="danger" onClick={() => void act(runtime.triggers.delete(trigger.id))}>
						刪除
					</button>
				</span>
			</span>
			<input
				type="checkbox"
				className="switch"
				aria-label={trigger.name}
				checked={trigger.enabled}
				onChange={(event) => void act(runtime.triggers.setEnabled(trigger.id, event.target.checked))}
			/>
		</div>
	);
}
