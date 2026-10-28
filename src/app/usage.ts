import type { ConversationView } from "@earendil-works/pi-durable";
import { usageOf } from "./docs.ts";
import type { Usage as ModelUsage } from "@earendil-works/pi-ai";
import { calculateContextTokens } from "@earendil-works/pi-ai/utils/estimate";

type Usage = Pick<ModelUsage, "input" | "output" | "cacheRead" | "cacheWrite">;

export function formatTokens(count: number): string {
	const short = (value: number) => value.toFixed(1).replace(/\.0$/, "");
	if (count >= 1_000_000) return `${short(count / 1_000_000)}M`;
	if (count >= 1000) return `${short(count / 1000)}k`;
	return String(count);
}

function lastUsage(view: ConversationView | undefined): ModelUsage | undefined {
	const message = view?.entries.findLast((entry) => entry.model?.[0]?.role === "assistant")?.model?.[0];
	return message?.role === "assistant" ? message.usage : undefined;
}

export const contextPercent = (used: number, window: number): number => (window ? Math.min(100, (used / window) * 100) : 0);

export function contextTokens(view: ConversationView | undefined): number {
	const usage = lastUsage(view);
	return usage ? calculateContextTokens(usage) : 0;
}

export function totalUsage(view: ConversationView | undefined): Usage {
	const models = usageOf(view)?.models ?? {};
	return Object.values(models).reduce(
		(sum, usage) => ({
			input: sum.input + usage.input,
			output: sum.output + usage.output,
			cacheRead: sum.cacheRead + usage.cacheRead,
			cacheWrite: sum.cacheWrite + usage.cacheWrite,
		}),
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	);
}

export function latestCacheHitRate(view: ConversationView | undefined): number | undefined {
	const usage = lastUsage(view);
	if (!usage) return undefined;
	const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
	return prompt > 0 ? (usage.cacheRead / prompt) * 100 : undefined;
}
