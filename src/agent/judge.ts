import type { JsonObject, Models } from "@earendil-works/pi-ai";

export type Question = { instructions: string; yes: string; no: string };

export type Verdict =
	| { kind: "answered"; probabilities: Record<string, number>; model: string }
	| { kind: "unavailable" }
	| { kind: "failed"; reason: string };

export interface Judge {
	available(): Promise<boolean>;
	ask(questions: Record<string, Question>, state: JsonObject): Promise<Verdict>;
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
	const pick = async () => {
		const available = await models.getAvailableOfType("classifier");
		return PREFERRED.map(([provider, id]) => available.find((item) => item.provider === provider && item.id === id)).find((item) => item !== undefined);
	};
	return {
		available: async () => (await pick()) !== undefined,
		async ask(questions, state) {
			const model = await pick();
			if (!model) return { kind: "unavailable" };
			const result = await models.classify(
				model,
				{
					state,
					questions: Object.fromEntries(
						Object.entries(questions).map(([key, question]) => [key, { type: "bool", instructions: question.instructions, criteria: { true: question.yes, false: question.no } }]),
					),
				},
				{ timeoutMs: TIMEOUT_MS },
			);
			if (result.stopReason !== "stop") return { kind: "failed", reason: `${model.id}: ${result.errorMessage ?? result.stopReason}` };
			const probabilities: Record<string, number> = {};
			for (const key of Object.keys(questions)) {
				const answer = result.answers[key];
				if (answer?.type !== "bool") return { kind: "failed", reason: `${model.id}: no answer to ${key}` };
				probabilities[key] = answer.probability;
			}
			return { kind: "answered", probabilities, model: model.id };
		},
	};
}
