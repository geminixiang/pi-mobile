// Typed reads of a conversation view's documents. ConversationView.docs is keyed by each document's persisted kind
// and holds that document's state, so the token both names the entry and types it. This is the one place that cast
// lives; components read documents through here instead of indexing `docs` with string keys.
import {
	AgentDoc,
	type AgentState,
	type ConversationDocToken,
	type ConversationView,
	InboxDoc,
	type InboxState,
	type JsonObject,
	LiveDoc,
	type LiveState,
	type RewindableConversationDocToken,
	UsageDoc,
	type UsageState,
} from "@earendil-works/pi-durable";

function doc<T extends JsonObject>(
	view: ConversationView | undefined,
	token: ConversationDocToken<T> | RewindableConversationDocToken<T>,
): T | undefined {
	return view?.docs[token.definition.kind] as T | undefined;
}

export const liveOf = (view: ConversationView | undefined): LiveState | undefined => doc(view, LiveDoc);
export const inboxOf = (view: ConversationView | undefined): InboxState | undefined => doc(view, InboxDoc);
export const agentOf = (view: ConversationView | undefined): AgentState | undefined => doc(view, AgentDoc);
export const usageOf = (view: ConversationView | undefined): UsageState | undefined => doc(view, UsageDoc);
