// CLIProxyAPI as a pi-ai provider: one model per catalog entry, each on the API CLIProxyAPI serves it best with.
// Mirrors pi-cliproxyapi-provider: Claude on Anthropic Messages, GPT-5.6/GPT-6 on Responses, the rest on Chat Completions.
import { type Api, createProvider, type Model, type Provider, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";

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

/** Metadata CLIProxyAPI's /v1/models does not report, for the models used most. */
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
		// The Anthropic driver appends /v1/messages itself. CLIProxyAPI accepts top-level adaptive thinking only.
		return { ...common, api: "anthropic-messages", baseUrl: rootUrl(baseUrl), compat: { forceAdaptiveThinking: true } };
	}
	const v1 = `${rootUrl(baseUrl)}/v1`;
	if (isCodexResponses(id)) return { ...common, api: "openai-responses", baseUrl: v1 };
	return { ...common, api: "openai-completions", baseUrl: v1, compat: { supportsStrictMode: false } };
}

/** Model IDs from CLIProxyAPI's catalog; favorites first. */
export async function fetchModelIds(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<string[]> {
	const response = await fetch(`${rootUrl(baseUrl)}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal });
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

export function cliProxyProvider(baseUrl: string, apiKey: string, modelIds: string[]): Provider {
	// Always include the favorites so conversations that use them resolve even when the catalog fetch failed.
	const ids = [...new Set([...FAVORITE_MODEL_IDS, ...modelIds])];
	return createProvider({
		id: PROVIDER_ID,
		name: "CLIProxyAPI",
		auth: { apiKey: { name: "CLIProxyAPI key", resolve: async () => ({ auth: { apiKey } }) } },
		models: ids.map((id) => toModel(id, baseUrl)),
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"openai-responses": openAIResponsesApi(),
			"openai-completions": openAICompletionsApi(),
		},
	});
}
