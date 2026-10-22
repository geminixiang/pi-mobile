// Custom model providers as pi-ai providers: any endpoint that speaks the OpenAI and/or Anthropic APIs, such as a
// self-hosted gateway, Ollama, or LM Studio. Its models come from its /v1/models; what that list does not say (name,
// context window, vision, reasoning) comes from pi-ai's catalogs when a model has a built-in provider's id, as a
// gateway's models usually do. Each model goes on the API that suits it: Claude on Anthropic Messages, GPT-5.6/GPT-6
// on Responses, the rest on Chat Completions.
import { type Api, createProvider, type Model, type ModelThinkingLevel, type Provider, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { Type } from "typebox";
import { parse } from "./parse.ts";

export const DEFAULT_MODEL_ID = "gpt-6.1-sol";
/** For a model no catalog knows. */
const DEFAULT_CONTEXT_WINDOW = 200_000;
/**
 * pi-durable compacts once a request would pass contextWindow minus its reserve (16k by default). Reporting the user's
 * threshold plus that reserve as the window makes it compact at the threshold instead of near the model's limit.
 */
const COMPACTION_RESERVE = 16_384;

export function windowFor(own: number, compactAt: number): number {
	return compactAt > 0 ? Math.min(own, compactAt + COMPACTION_RESERVE) : own;
}

/** A model as the picker shows it. */
export interface ModelInfo {
	provider: string;
	providerName: string;
	id: string;
	name: string;
	/** In a catalog: its metadata is known, not defaulted. */
	known: boolean;
	/** Where its conversations compact (windowFor), and the model's own limit. */
	contextWindow: number;
	ownWindow: number;
	vision: boolean;
	reasoning: boolean;
}

export function describe(model: Model<Api>, providerName: string, compactAt: number, known = true): ModelInfo {
	return {
		provider: model.provider,
		providerName,
		id: model.id,
		name: model.name,
		known,
		contextWindow: windowFor(model.contextWindow, compactAt),
		ownWindow: model.contextWindow,
		vision: model.input.includes("image"),
		reasoning: model.reasoning,
	};
}

/**
 * The provider with each model's context window capped at the compaction threshold. Built-in providers are objects
 * with methods; the copy keeps them through its prototype and overrides only the model lists.
 */
export function withCompaction(provider: Provider, compactAt: number): Provider {
	const capped = (model: Model<Api>): Model<Api> => ({ ...model, contextWindow: windowFor(model.contextWindow, compactAt) });
	const wrapped: Provider = Object.create(provider);
	// defineProperty, not assignment: a wrapper below may have defined getModels read-only.
	return Object.defineProperty(wrapped, "getModels", { value: () => provider.getModels().map(capped) });
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ModelThinkingLevel[];

/** A thinking level from settings or the model sheet; anything else is not one. */
export function isThinkingLevel(value: string): value is ModelThinkingLevel {
	return THINKING_LEVELS.some((level) => level === value);
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

/** OpenAI's and Anthropic's /v1/models both list `{ id }` objects under `data`. */
const ModelList = Type.Object({ data: Type.Optional(Type.Array(Type.Object({ id: Type.String() }))) });

const baseName = (id: string) => id.slice(id.lastIndexOf("/") + 1);
const isClaude = (id: string) => /^claude(?:-|$)/.test(baseName(id));
const isCodexResponses = (id: string) => /^gpt-5\.6(?:-|$)|^gpt-6(?:\.\d+)?(?:-|$)/.test(baseName(id));

function rootUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/u, "").replace(/\/v1$/u, "");
}

/** Catalog entries by model id, from built-in providers, for what a custom endpoint's list does not say. */
export type Catalog = ReadonlyMap<string, Model<Api>>;

function toModel(id: string, provider: string, baseUrl: string, catalog: Catalog): Model<Api> {
	const known = catalog.get(baseName(id));
	const common = {
		id,
		name: known?.name ?? id,
		provider,
		reasoning: known?.reasoning ?? true,
		input: known?.input ?? (["text", "image"] satisfies ("text" | "image")[]),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: known?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
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

/** Model IDs from an endpoint's /v1/models, sorted. */
export async function fetchModelIds(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<string[]> {
	// OpenAI-style auth first. Anthropic headers are only for Anthropic's own API: a gateway that sees them may answer
	// with its Anthropic catalog alone (some list only Claude models then).
	const url = `${rootUrl(baseUrl)}/v1/models`;
	const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
	let response = await fetch(url, { headers, signal });
	if (response.status === 401 || response.status === 403) {
		response = await fetch(url, {
			headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
			signal,
		});
	}
	if (!response.ok) throw new Error(`GET /v1/models: HTTP ${response.status}`);
	const body = parse(ModelList, await response.json(), "GET /v1/models");
	return [...new Set((body.data ?? []).map((model) => model.id))].sort();
}

/** A custom endpoint as a provider with the models it listed. */
export function customProvider(config: { id: string; name: string; baseUrl: string }, apiKey: string, modelIds: readonly string[], catalog: Catalog): Provider {
	return createProvider({
		id: config.id,
		name: config.name,
		auth: { apiKey: { name: "API key", resolve: async () => ({ auth: { apiKey } }) } },
		models: modelIds.map((id) => toModel(id, config.id, config.baseUrl, catalog)),
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"openai-responses": openAIResponsesApi(),
			"openai-completions": openAICompletionsApi(),
		},
	});
}

/** Whether a custom endpoint's model is in a catalog, so its metadata is real. */
export function inCatalog(catalog: Catalog, id: string): boolean {
	return catalog.has(baseName(id));
}
