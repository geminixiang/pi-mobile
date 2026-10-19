// The model service as a pi-ai provider: any endpoint that speaks the OpenAI and/or Anthropic APIs, such as a gateway
// (CLIProxyAPI, LiteLLM), OpenAI, or Anthropic. One model per catalog entry, each on the API that suits it: Claude on
// Anthropic Messages, GPT-5.6/GPT-6 on Responses, the rest on Chat Completions.
import { type Api, createProvider, type Model, type Provider, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";

/** Stored in every conversation's model reference, so it keeps its original value. */
export const PROVIDER_ID = "cliproxyapi";
export const DEFAULT_MODEL_ID = "claude-opus-5-5";
const DEFAULT_CONTEXT_WINDOW = 200_000;

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

const baseName = (id: string) => id.slice(id.lastIndexOf("/") + 1);
const isClaude = (id: string) => /^claude(?:-|$)/.test(baseName(id));
const isCodexResponses = (id: string) => /^gpt-5\.6(?:-|$)|^gpt-6(?:\.\d+)?(?:-|$)/.test(baseName(id));

function rootUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/u, "").replace(/\/v1$/u, "");
}

function toModel(id: string, baseUrl: string): Model<Api> {
	const known = KNOWN[id];
	const common = {
		id,
		name: known?.name ?? id,
		provider: PROVIDER_ID,
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: known?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: known?.maxTokens ?? 32_000,
		thinkingLevelMap: LEVELS,
	};
	if (isClaude(id)) {
		// The Anthropic driver appends /v1/messages itself. Gateways such as CLIProxyAPI accept top-level adaptive thinking only.
		return { ...common, api: "anthropic-messages", baseUrl: rootUrl(baseUrl), compat: { forceAdaptiveThinking: true } };
	}
	const v1 = `${rootUrl(baseUrl)}/v1`;
	if (isCodexResponses(id)) return { ...common, api: "openai-responses", baseUrl: v1 };
	return { ...common, api: "openai-completions", baseUrl: v1, compat: { supportsStrictMode: false } };
}

/** Model IDs from the service's /v1/models; favorites first. */
export async function fetchModelIds(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<string[]> {
	// Bearer for OpenAI-style services, x-api-key and a version for Anthropic's; each ignores the other's headers.
	const response = await fetch(`${rootUrl(baseUrl)}/v1/models`, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
			"anthropic-dangerous-direct-browser-access": "true",
		},
		signal,
	});
	if (!response.ok) throw new Error(`GET /v1/models: HTTP ${response.status}`);
	const body = (await response.json()) as { data?: { id: string }[] };
	const ids = new Set((body.data ?? []).map((model) => model.id));
	const favorites = FAVORITE_MODEL_IDS.filter((id) => ids.has(id));
	const rest = [...ids].filter((id) => !KNOWN[id]).sort();
	return [...favorites, ...rest];
}

export function describeModels(ids: string[]): ModelInfo[] {
	return ids.map((id) => ({
		id,
		name: KNOWN[id]?.name ?? id,
		known: Boolean(KNOWN[id]),
		contextWindow: KNOWN[id]?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
	}));
}

export function modelServiceProvider(baseUrl: string, apiKey: string, modelIds: string[]): Provider {
	// Always include the favorites so conversations that use them resolve even when the catalog fetch failed.
	const ids = [...new Set([...FAVORITE_MODEL_IDS, ...modelIds])];
	return createProvider({
		id: PROVIDER_ID,
		name: "Model service",
		auth: { apiKey: { name: "API key", resolve: async () => ({ auth: { apiKey } }) } },
		models: ids.map((id) => toModel(id, baseUrl)),
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"openai-responses": openAIResponsesApi(),
			"openai-completions": openAICompletionsApi(),
		},
	});
}
