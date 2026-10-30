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
	// why: pi-durable keys a view's docs by kind as JsonObject; the token's kind fixes the shape, which its types do not link.
	return view?.docs[token.definition.kind] as T | undefined;
}

export const liveOf = (view: ConversationView | undefined): LiveState | undefined => doc(view, LiveDoc);
export const inboxOf = (view: ConversationView | undefined): InboxState | undefined => doc(view, InboxDoc);
export const agentOf = (view: ConversationView | undefined): AgentState | undefined => doc(view, AgentDoc);
export const usageOf = (view: ConversationView | undefined): UsageState | undefined => doc(view, UsageDoc);
