import type { JsonObject, Models } from "@earendil-works/pi-ai";

export type Verdict = { kind: "answered"; probability: number; model: string } | { kind: "unanswered"; reason: string };

export interface Judge {
	ask(question: string, state: JsonObject): Promise<Verdict>;
}

export const LIKELY = 0.5;

const PREFERRED: readonly [provider: string, id: string][] = [
	["openrouter", "~typesafe/jev-latest"],
	["typesafe", "jev-latest"],
	["cloudflare-workers-ai", "typesafe/jev"],
	["vercel-ai-gateway", "typesafe-ai/jev"],
];
const TIMEOUT_MS = 15_000;

export function createJudge(models: Models): Judge {
	return {
		async ask(question, state) {
			const available = await models.getAvailableOfType("classifier");
			const model = PREFERRED.map(([provider, id]) => available.find((item) => item.provider === provider && item.id === id)).find((item) => item !== undefined);
			if (!model) return { kind: "unanswered", reason: "no Jev model: add an OpenRouter, TypeSafe, Cloudflare or Vercel AI Gateway key in Settings" };
			const result = await models.classify(
				model,
				{ state, questions: { answer: { type: "bool", instructions: question, criteria: { true: "Yes", false: "No" } } } },
				{ timeoutMs: TIMEOUT_MS },
			);
			const answer = result.answers.answer;
			if (result.stopReason === "stop" && answer?.type === "bool") return { kind: "answered", probability: answer.probability, model: model.id };
			return { kind: "unanswered", reason: `${model.id}: ${result.errorMessage ?? result.stopReason}` };
		},
	};
}
