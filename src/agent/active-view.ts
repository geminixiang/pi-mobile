import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, ConversationView, EntryRecord } from "@earendil-works/pi-durable";

// why: pi-durable's view is a window over the whole history (50–100 entries by default); this bound keeps every entry since the latest reset or compaction in it.
const WHOLE = 1_000_000;

type ActiveView = {
	readonly value: ConversationView;
	subscribe(listener: (view: ConversationView) => void): () => void;
	dispose(): Promise<void>;
};

export async function activeView(conversation: Conversation): Promise<ActiveView> {
	const { head } = await conversation.context(BACKGROUND_CONTEXT);
	const watch = await conversation.watch(BACKGROUND_CONTEXT, { min: WHOLE, ...(head?.head === undefined ? {} : { from: head.head }) });
	const listeners = new Set<(view: ConversationView) => void>();
	let raw = watch.value.entries;
	let value = withActive(watch.value, active(raw));
	watch.start(async (call) => {
		if (call.kind !== "value") return;
		const entries = call.value.entries === raw ? value.entries : active(call.value.entries);
		raw = call.value.entries;
		value = withActive(call.value, entries);
		for (const listener of listeners) listener(value);
	});
	return {
		get value() {
			return value;
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		dispose: async () => {
			listeners.clear();
			await watch.stop();
		},
	};
}

const withActive = ({ conversation, docs }: ConversationView, entries: readonly EntryRecord[]): ConversationView => ({ conversation, docs, entries });

function active(history: readonly EntryRecord[]): readonly EntryRecord[] {
	const entries: EntryRecord[] = [];
	for (const entry of history) {
		const target = entry.head;
		if (target === undefined) {
			entries.push(entry);
			continue;
		}
		const kept = entries.findIndex((candidate) => candidate.head === undefined && candidate.id >= target);
		entries.splice(0, kept < 0 ? entries.length : kept, entry);
	}
	return entries;
}
