// The model service as a pi-ai provider: any endpoint that speaks the OpenAI and/or Anthropic APIs, such as a gateway
// (LiteLLM and the like), OpenAI, or Anthropic. One model per catalog entry, each on the API that suits it: Claude on
// Anthropic Messages, GPT-5.6/GPT-6 on Responses, the rest on Chat Completions.
import { type Api, createProvider, type Model, type Provider, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { Type } from "typebox";
import { parse } from "./parse.ts";

/** Stored in every conversation's model reference, so it keeps its original value. */
export const PROVIDER_ID = "cliproxyapi";
// GPT on Responses: gateways pass its instructions and tool names through. Claude on a subscription OAuth
// credential is cloaked as Claude Code (its system prompt first, tools renamed mcp__x__y), which confuses the agent.
export const DEFAULT_MODEL_ID = "gpt-6.1-sol";
const DEFAULT_CONTEXT_WINDOW = 200_000;
/**
 * pi-durable compacts once a request would pass contextWindow minus its reserve (16k by default). Reporting the user's
 * threshold plus that reserve as the window makes it compact at the threshold instead of near the model's limit.
 */
const COMPACTION_RESERVE = 16_384;

function windowFor(id: string, compactAt: number): number {
	const own = KNOWN[id]?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
	return compactAt > 0 ? Math.min(own, compactAt + COMPACTION_RESERVE) : own;
}

export interface ModelInfo {
	id: string;
	name: string;
	/** Known metadata; unknown catalog entries get conservative defaults. */
	known: boolean;
	contextWindow: number;
}

const LEVELS: ThinkingLevelMap = {
	off: null,
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

/** Metadata /v1/models does not report, for the models used most. */
const KNOWN: Record<string, { name: string; contextWindow: number; maxTokens: number }> = {
	"claude-opus-5-5": { name: "Claude Opus 5.5", contextWindow: 1_000_000, maxTokens: 128_000 },
	"claude-sonnet-5": { name: "Claude Sonnet 5", contextWindow: 1_000_000, maxTokens: 128_000 },
	"claude-fable-5-1": { name: "Claude Fable 5.1", contextWindow: 1_000_000, maxTokens: 128_000 },
	"gpt-6.1-sol": { name: "GPT 6.1 Sol", contextWindow: 500_000, maxTokens: 128_000 },
	"gpt-6-astra": { name: "GPT 6.0 Astra", contextWindow: 272_000, maxTokens: 128_000 },
	"gpt-6-luna": { name: "GPT 6.0 Luna", contextWindow: 272_000, maxTokens: 128_000 },
	"gpt-5.6-sol": { name: "GPT 5.6 Sol", contextWindow: 272_000, maxTokens: 128_000 },
};

export const FAVORITE_MODEL_IDS = Object.keys(KNOWN);

/** OpenAI's and Anthropic's /v1/models both list `{ id }` objects under `data`. */
const ModelList = Type.Object({ data: Type.Optional(Type.Array(Type.Object({ id: Type.String() }))) });

const baseName = (id: string) => id.slice(id.lastIndexOf("/") + 1);
const isClaude = (id: string) => /^claude(?:-|$)/.test(baseName(id));
const isCodexResponses = (id: string) => /^gpt-5\.6(?:-|$)|^gpt-6(?:\.\d+)?(?:-|$)/.test(baseName(id));

function rootUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/u, "").replace(/\/v1$/u, "");
}

function toModel(id: string, baseUrl: string, compactAt: number): Model<Api> {
	const known = KNOWN[id];
	const common = {
		id,
		name: known?.name ?? id,
		provider: PROVIDER_ID,
		reasoning: true,
		input: ["text", "image"] satisfies ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: windowFor(id, compactAt),
		maxTokens: known?.maxTokens ?? 32_000,
		thinkingLevelMap: LEVELS,
	};
	if (isClaude(id)) {
		// The Anthropic driver appends /v1/messages itself. Some gateways accept top-level adaptive thinking only.
		return { ...common, api: "anthropic-messages", baseUrl: rootUrl(baseUrl), compat: { forceAdaptiveThinking: true } };
	}
	const v1 = `${rootUrl(baseUrl)}/v1`;
	if (isCodexResponses(id)) return { ...common, api: "openai-responses", baseUrl: v1 };
	return { ...common, api: "openai-completions", baseUrl: v1, compat: { supportsStrictMode: false } };
}

/** Model IDs from the service's /v1/models; favorites first. */
export async function fetchModelIds(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<string[]> {
	// OpenAI-style auth first. Anthropic headers are only for Anthropic's own API: a gateway that sees them may answer
	// with its Anthropic catalog alone (some list only Claude models then).
	const url = `${rootUrl(baseUrl)}/v1/models`;
	let response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal });
	if (response.status === 401 || response.status === 403) {
		response = await fetch(url, {
			headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
			signal,
		});
	}
	if (!response.ok) throw new Error(`GET /v1/models: HTTP ${response.status}`);
	const body = parse(ModelList, await response.json(), "GET /v1/models");
	const ids = new Set((body.data ?? []).map((model) => model.id));
	const favorites = FAVORITE_MODEL_IDS.filter((id) => ids.has(id));
	const rest = [...ids].filter((id) => !KNOWN[id]).sort();
	return [...favorites, ...rest];
}

/** `contextWindow` is the size at which conversations compact (see windowFor). */
export function describeModels(ids: string[], compactAt: number): ModelInfo[] {
	return ids.map((id) => ({
		id,
		name: KNOWN[id]?.name ?? id,
		known: Boolean(KNOWN[id]),
		contextWindow: windowFor(id, compactAt),
	}));
}

export function modelServiceProvider(baseUrl: string, apiKey: string, modelIds: string[], compactAt: number): Provider {
	// Always include the favorites so conversations that use them resolve even when the catalog fetch failed.
	const ids = [...new Set([...FAVORITE_MODEL_IDS, ...modelIds])];
	return createProvider({
		id: PROVIDER_ID,
		name: "Model service",
		auth: { apiKey: { name: "API key", resolve: async () => ({ auth: { apiKey } }) } },
		models: ids.map((id) => toModel(id, baseUrl, compactAt)),
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"openai-responses": openAIResponsesApi(),
			"openai-completions": openAICompletionsApi(),
		},
	});
}
