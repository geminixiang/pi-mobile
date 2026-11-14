import { type ReactNode, useState } from "react";
import type { Bot } from "../agent/bots.ts";
import type { AgentRuntime } from "../agent/runtime.ts";
import { DAY, startOfToday } from "../time.ts";
import type { LastRun, Trigger } from "./runs.ts";
import { messageOf } from "../promise.ts";
import { CalendarIcon, CheckIcon, CloseIcon, EyeIcon, RepeatIcon, SkipIcon, TerminalIcon, TriggerIcon } from "../app/icons.tsx";
import { clockOf, describeAgo, describeDay, describeRule, isEvent, triggerSymbol } from "./when.ts";
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

const DELIVERY_LABEL = { live: "背景執行", later: "打開 pi 後執行", manual: "你手動執行" };

const percent = (probability: number) => `${Math.round(probability * 100)}%`;

function lastRun(last: LastRun): string {
	if (last.outcome === "failed") return last.error;
	const probability = last.confidence?.kind === "judged" ? last.confidence.probability : undefined;
	if (last.outcome === "skipped") return `略過：${last.reason}${probability !== undefined ? `（${percent(probability)}）` : ""}`;
	const judged = probability !== undefined ? ` · 判斷 ${percent(probability)}` : last.confidence ? " · 沒有判斷" : "";
	return `${DELIVERY_LABEL[last.delivery]}${judged}`;
}

const OUTCOME: Record<LastRun["outcome"], { label: string; icon: ReactNode }> = {
	ran: { label: "上次跑完了", icon: <CheckIcon size={13} /> },
	failed: { label: "上次失敗", icon: <CloseIcon size={13} /> },
	skipped: { label: "上次略過", icon: <SkipIcon size={13} /> },
};

function lead(trigger: Trigger, next: number | undefined): ReactNode {
	const when = trigger.when;
	if (isEvent(when)) return <TriggerIcon symbol={triggerSymbol(when)} />;
	if (next !== undefined) return clockOf(next);
	return when.kind === "daily" ? when.time : clockOf(when.at);
}

function kindIcon(trigger: Trigger): ReactNode {
	if (trigger.kind === "followup") return <EyeIcon size={14} />;
	if (trigger.kind === "watch") return <TerminalIcon size={14} />;
	if (trigger.when.kind === "daily") return <RepeatIcon />;
	if (trigger.when.kind === "once") return <CalendarIcon />;
	return null;
}

function summary(trigger: Trigger, next: number | undefined, bot: Bot | "deleted" | undefined): string {
	const tomorrow = startOfToday() + DAY;
	const when = trigger.when;
	const day = trigger.state === "on" && next !== undefined && next >= tomorrow ? (next < tomorrow + DAY ? "明天" : describeDay(next)) : undefined;
	const window = isEvent(when) && (when.from || when.until) ? `${when.from ?? "00:00"}–${when.until ?? "24:00"}` : undefined;
	const owner = bot ? (bot === "deleted" ? "已刪除的 Bot" : bot.name) : undefined;
	return [owner, day, window].filter(Boolean).join(" · ");
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
	const sub = summary(trigger, next, bot);
	const rule = describeRule(trigger.when);
	return (
		<div className={`trigger-row${trigger.state === "paused" ? " paused" : ""}`}>
			<div className="trigger-line">
				<button type="button" className="trigger-open" aria-expanded={open} onClick={() => setOpen(!open)}>
					<span className="trigger-lead">{lead(trigger, next)}</span>
					<span className="trigger-kind">{kindIcon(trigger)}</span>
					<span className="list-text">
						<span className="list-name">{trigger.name}</span>
						{sub ? <span className="list-sub">{sub}</span> : null}
					</span>
					{last ? (
						<span className={`trigger-outcome ${last.outcome}`} role="img" aria-label={OUTCOME[last.outcome].label}>
							{OUTCOME[last.outcome].icon}
						</span>
					) : null}
				</button>
			</div>
			{open ? (
				<div className="trigger-detail">
					{rule ? <p>{rule}</p> : null}
					{trigger.onlyIf ? <p>只在：{trigger.onlyIf}</p> : null}
					{last ? <p className={last.outcome === "failed" ? "error" : undefined}>{`上次 ${describeAgo(last.at, startOfToday())} · ${lastRun(last)}`}</p> : null}
					{isEvent(trigger.when) ? <GuardChips name={trigger.name} guards={guards} onChange={(chosen) => void act(runtime.triggers.setGuards(trigger.id, chosen))} /> : null}
					<span className="trigger-actions">
						<button type="button" onClick={() => void act(runtime.triggers.run(trigger.id, "manual"))}>
							立即執行
						</button>
						{trigger.state === "fired" ? null : (
							<button type="button" onClick={() => void act(runtime.triggers.setPaused(trigger.id, trigger.state === "on"))}>
								{trigger.state === "on" ? "暫停" : "恢復"}
							</button>
						)}
						<button type="button" className="danger" onClick={() => void act(runtime.triggers.delete(trigger.id))}>
							刪除
						</button>
					</span>
				</div>
			) : null}
		</div>
	);
}
