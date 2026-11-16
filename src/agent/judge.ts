import { Type } from "typebox";
import { type Api, contentText, type JsonObject, type Model, type Models } from "@earendil-works/pi-ai";
import { messageOf } from "../promise.ts";
import { checkJson } from "../parse.ts";

export type Question = { instructions: string; yes: string; no: string };

export type Verdict =
	| { kind: "answered"; probabilities: Record<string, number>; model: string }
	| { kind: "unavailable" }
	| { kind: "failed"; reason: string };

export interface Judge {
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
const CHAT_TOKENS = 400;
const CHAT_TIMEOUT_MS = 30_000;
const Answers = Type.Record(Type.String(), Type.Boolean());

export function createJudge(models: Models, chat?: Model<Api>): Judge {
	const pick = async () => {
		const available = await models.getAvailableOfType("classifier");
		return PREFERRED.map(([provider, id]) => available.find((item) => item.provider === provider && item.id === id)).find((item) => item !== undefined);
	};
	const ask: Judge["ask"] = async (questions, state) => {
		const model = await pick();
		if (!model) return chat ? askChat(models, chat, questions, state) : { kind: "unavailable" };
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
	};
	return { ask: (questions, state) => ask(questions, state).catch((error: unknown) => ({ kind: "failed", reason: messageOf(error) })) };
}

async function askChat(models: Models, model: Model<Api>, questions: Record<string, Question>, state: JsonObject): Promise<Verdict> {
	const asked = Object.entries(questions).map(([key, question]) => `${key}: ${question.instructions} true: ${question.yes}. false: ${question.no}.`);
	const prompt = [`Facts: ${JSON.stringify(state)}`, "Reply with only a JSON object giving true or false for each key:", ...asked].join("\n");
	const reply = await models.completeSimple(model, { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] }, { maxTokens: CHAT_TOKENS, reasoning: "minimal", signal: AbortSignal.timeout(CHAT_TIMEOUT_MS) });
	if (reply.stopReason === "error" || reply.stopReason === "aborted") return { kind: "failed", reason: `${model.id}: ${reply.errorMessage ?? reply.stopReason}` };
	const text = contentText(reply.content);
	const answers = checkJson(Answers, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1), "judge reply");
	if (!answers.ok) return { kind: "failed", reason: `${model.id}: ${answers.problem}` };
	const probabilities: Record<string, number> = {};
	for (const key of Object.keys(questions)) {
		const answer = answers.value[key];
		if (answer === undefined) return { kind: "failed", reason: `${model.id}: no answer to ${key}` };
		probabilities[key] = answer ? 1 : 0;
	}
	return { kind: "answered", probabilities, model: model.id };
}
