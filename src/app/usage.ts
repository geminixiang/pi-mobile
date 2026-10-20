import type { ConversationView } from "@earendil-works/pi-durable";
import { usageOf } from "./docs.ts";

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
	return String(count);
}

/** Context in use: the newest answer's prompt plus its output, as pi's footer shows it. */
export function contextTokens(view: ConversationView | undefined): number {
	for (let i = (view?.entries.length ?? 0) - 1; i >= 0; i--) {
		const message = view?.entries[i]?.model?.[0];
		if (message?.role === "assistant") {
			const usage = message.usage;
			return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		}
	}
	return 0;
}

/** Tokens the conversation spent, summed over models. */
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

/**
 * Prompt cache hit rate of the newest answer, as pi's footer computes it (CH%): its cache reads over its whole prompt,
 * `cacheRead / (input + cacheRead + cacheWrite)`, in percent. Undefined when that answer reported no prompt tokens
 * (an aborted or failed request); pi shows it only once the conversation has any cache activity (`hasCacheActivity`).
 */
export function latestCacheHitRate(view: ConversationView | undefined): number | undefined {
	for (let i = (view?.entries.length ?? 0) - 1; i >= 0; i--) {
		const message = view?.entries[i]?.model?.[0];
		if (message?.role !== "assistant") continue;
		const { input, cacheRead, cacheWrite } = message.usage;
		const prompt = input + cacheRead + cacheWrite;
		return prompt > 0 ? (cacheRead / prompt) * 100 : undefined;
	}
	return undefined;
}

export function hasCacheActivity(usage: Usage): boolean {
	return usage.cacheRead > 0 || usage.cacheWrite > 0;
}
