import type { ToolCall } from "@earendil-works/pi-ai";
import { QuestionCard } from "./QuestionCard.tsx";
import { ASK_USER } from "./tool.ts";

export function InteractionCard({ call }: { call: ToolCall }) {
	switch (call.name) {
		case ASK_USER:
			return <QuestionCard call={call} />;
		default:
			return null;
	}
}
