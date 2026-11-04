import type { EntryRecord } from "@earendil-works/pi-durable";
import { blocks, message, type Block } from "../agent/entries.ts";
import { isInteraction } from "../interaction/tool.ts";

export type Call = Extract<Block, { type: "toolCall" }>;

export type StepRun = { carried: readonly Call[]; hidden: boolean; since: number | undefined };

export const LONE_RUN: StepRun = { carried: [], hidden: false, since: undefined };

const PASSING = new Set(["pi.tool-result", "pi.system"]);

const shown = (entry: EntryRecord) => blocks(message(entry)?.content).filter((block) => block.type !== "thinking");
const isStep = (block: Block | undefined): block is Call => block?.type === "toolCall" && !isInteraction(block.name);

function trailingSteps(content: readonly Block[]): readonly Call[] {
	const lastOther = content.findLastIndex((block) => !isStep(block));
	return content.slice(lastOther + 1).filter(isStep);
}

export function stepRuns(entries: readonly EntryRecord[]): ReadonlyMap<EntryRecord, StepRun> {
	const answers = entries.filter((entry) => !PASSING.has(entry.kind));
	const runs = new Map<EntryRecord, StepRun>();
	let open: { calls: readonly Call[]; since: number | undefined } | undefined;
	answers.forEach((entry, index) => {
		if (entry.kind !== "pi.assistant") {
			open = undefined;
			return;
		}
		const content = shown(entry);
		const carried = isStep(content[0]) ? open : undefined;
		const next = answers[index + 1];
		const tail = trailingSteps(content);
		const hidden = tail.length > 0 && next?.kind === "pi.assistant" && isStep(shown(next)[0]);
		const stamp = message(entry)?.timestamp;
		const since = carried?.since ?? stamp;
		open = hidden ? { calls: [...(tail.length === content.length ? (carried?.calls ?? []) : []), ...tail], since } : undefined;
		if (carried || hidden) runs.set(entry, { carried: carried?.calls ?? [], hidden, since });
	});
	return runs;
}

export function sameRun(before: StepRun, after: StepRun): boolean {
	return before.hidden === after.hidden && before.since === after.since && before.carried.length === after.carried.length;
}
