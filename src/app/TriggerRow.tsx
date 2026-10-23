import type { Bot } from "../agent/bots.ts";
import type { AgentRuntime } from "../agent/runtime.ts";
import { describeTime, describeWhen, type Trigger } from "../agent/triggers.ts";
import { messageOf } from "../promise.ts";

const DELIVERY_LABEL = { live: "背景執行", later: "打開 pi 後執行", manual: "手動執行" };

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
		<div className="check-row trigger-row">
			<span className="menu-text">
				{trigger.kind === "followup" ? `稍後再看：${trigger.name}` : trigger.name}
				<span className="menu-hint">
					{bot ? `${bot === "deleted" ? "已刪除的 Bot" : bot.name} · ` : ""}
					{describeWhen(trigger.when)}
					{trigger.enabled && next ? ` · 下次 ${describeTime(next)}` : ""}
				</span>
				{last ? (
					<span className={`menu-hint${last.error ? " error" : ""}`}>
						上次 {describeTime(last.at)} {last.error ?? DELIVERY_LABEL[last.delivery]}
					</span>
				) : null}
				<span className="trigger-actions">
					<button type="button" onClick={() => void act(runtime.runTrigger(trigger.id, "manual"))}>
						立即執行
					</button>
					<button type="button" className="danger" onClick={() => void act(runtime.deleteTrigger(trigger.id))}>
						刪除
					</button>
				</span>
			</span>
			<button type="button" className="toggle" aria-pressed={trigger.enabled} onClick={() => void act(runtime.setTriggerEnabled(trigger.id, !trigger.enabled))}>
				{trigger.enabled ? "開啟" : "暫停"}
			</button>
		</div>
	);
}
