import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { type Trigger, TriggerDoc } from "./runs.ts";
import type { TriggerHost } from "./tool.ts";

export async function triggersOf(api: ToolExecutionApi, context: Context): Promise<readonly Trigger[]> {
	return (await api.snapshot(TriggerDoc, context))?.items ?? [];
}

export async function editTriggers(api: ToolExecutionApi, context: Context, host: TriggerHost, edit: (items: Trigger[]) => Trigger[]): Promise<void> {
	await api.commit(async (tx) => {
		const doc = await tx.doc(TriggerDoc);
		doc.items = edit(doc.items);
	}, context);
	host.changed();
}
