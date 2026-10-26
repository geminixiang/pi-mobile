import type { ConversationView } from "@earendil-works/pi-durable";
import { usageOf } from "./docs.ts";
import type { Usage as ModelUsage } from "@earendil-works/pi-ai";
import { calculateContextTokens } from "@earendil-works/pi-ai/utils/estimate";

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export function formatTokens(count: number): string {
	const short = (value: number) => value.toFixed(1).replace(/\.0$/, "");
	if (count >= 1_000_000) return `${short(count / 1_000_000)}M`;
	if (count >= 1000) return `${short(count / 1000)}k`;
	return String(count);
}

function lastUsage(view: ConversationView | undefined): ModelUsage | undefined {
	for (let i = (view?.entries.length ?? 0) - 1; i >= 0; i--) {
		const message = view?.entries[i]?.model?.[0];
		if (message?.role === "assistant") return message.usage;
	}
	return undefined;
}

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
