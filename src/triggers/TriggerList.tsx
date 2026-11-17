import type { Bot } from "../agent/bots.ts";
import { DAY, startOfToday } from "../time.ts";
import type { Trigger, TriggerRuns } from "./runs.ts";
import { TriggerRow } from "./TriggerRow.tsx";
import { grouped } from "./when.ts";

export function TriggerList({
	triggers,
	next,
	bots,
	runs,
	onError,
}: {
	triggers: readonly Trigger[];
	next: Readonly<Record<string, number>>;
	bots?: readonly Bot[];
	runs: TriggerRuns;
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
					runs={runs}
					onError={onError}
				/>
			))}
		</section>
	));
}
