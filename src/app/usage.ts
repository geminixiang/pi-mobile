import type { ConversationView } from "@earendil-works/pi-durable";

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
		const message = view?.entries[i]?.model?.[0] as { role?: string; usage?: Usage } | undefined;
		if (message?.role === "assistant" && message.usage) {
			const usage = message.usage;
			return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		}
	}
	return 0;
}

/** Tokens the conversation spent, summed over models. */
export function totalUsage(view: ConversationView | undefined): Usage {
	const models = (view?.docs["pi.usage"] as { models?: Record<string, Usage> } | undefined)?.models ?? {};
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
