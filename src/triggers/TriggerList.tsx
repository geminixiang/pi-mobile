import type { Bot } from "../agent/bots.ts";
import type { AgentRuntime } from "../agent/runtime.ts";
import { DAY, startOfToday } from "../time.ts";
import type { Trigger } from "./runs.ts";
import { TriggerRow } from "./TriggerRow.tsx";
import { grouped } from "./when.ts";

export function TriggerList({
	triggers,
	next,
	bots,
	runtime,
	onError,
}: {
	triggers: readonly Trigger[];
	next: Readonly<Record<string, number>>;
	bots?: readonly Bot[];
	runtime: AgentRuntime;
	onError: (message: string) => void;
}) {
	return grouped(triggers, next, startOfToday() + DAY).map((section) => (
		<section key={section.label} className="trigger-group">
			<h3 className="list-label">{section.label}</h3>
			{section.triggers.map((trigger) => (
				<TriggerRow
					key={trigger.id}
					trigger={trigger}
					next={next[trigger.id]}
					{...(bots ? { bot: bots.find((bot) => bot.id === trigger.conversationId) ?? "deleted" } : {})}
					runtime={runtime}
					onError={onError}
				/>
			))}
		</section>
	));
}
