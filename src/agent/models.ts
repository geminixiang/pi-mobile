import { type Api, createProvider, type Model, type ModelThinkingLevel, type Provider, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { Type } from "typebox";
import { parse } from "./parse.ts";
import { onTailnet, refuseCleartextSecret, refuseIpOnIos, tailscaleHint } from "./cleartext.ts";
import { ios } from "../native.ts";

export const DEFAULT_MODEL_ID = "gpt-6.1-sol";
const DEFAULT_CONTEXT_WINDOW = 200_000;
const COMPACTION_RESERVE = 16_384;

function windowFor(own: number, compactAt: number): number {
	return compactAt > 0 ? Math.min(own, compactAt + COMPACTION_RESERVE) : own;
}

export interface ModelInfo {
	provider: string;
	providerName: string;
	id: string;
	name: string;
	known: boolean;
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

export function withCompaction(provider: Provider, compactAt: number): Provider {
	const capped = (model: Model<Api>): Model<Api> => ({ ...model, contextWindow: windowFor(model.contextWindow, compactAt) });
	const wrapped: Provider = Object.create(provider);
	return Object.defineProperty(wrapped, "getModels", { value: () => provider.getModels().map(capped) });
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ModelThinkingLevel[];

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

const ModelList = Type.Object({ data: Type.Optional(Type.Array(Type.Object({ id: Type.String() }))) });

const baseName = (id: string) => id.slice(id.lastIndexOf("/") + 1);
const isClaude = (id: string) => /^claude(?:-|$)/.test(baseName(id));
const isCodexResponses = (id: string) => /^gpt-5\.6(?:-|$)|^gpt-6(?:\.\d+)?(?:-|$)/.test(baseName(id));

export function rootUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/u, "").replace(/\/v1$/u, "");
}

export function anthropicHeaders(apiKey: string): Record<string, string> {
	return { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" };
}

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
		return { ...common, api: "anthropic-messages", baseUrl: rootUrl(baseUrl), compat: { forceAdaptiveThinking: true } };
	}
	const v1 = `${rootUrl(baseUrl)}/v1`;
	if (isCodexResponses(id)) return { ...common, api: "openai-responses", baseUrl: v1 };
	return { ...common, api: "openai-completions", baseUrl: v1, compat: { supportsStrictMode: false } };
}

export async function fetchModelIds(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<string[]> {
	const url = `${rootUrl(baseUrl)}/v1/models`;
	refuseIpOnIos(url, ios);
	if (apiKey) refuseCleartextSecret(url);
	const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
	const reach = (request: Promise<Response>) =>
		onTailnet(url)
			? request.catch((error: unknown) => {
					throw new Error(`連不到 ${new URL(url).host}：Tailscale 要連著${tailscaleHint(ios)}`, { cause: error });
				})
			: request;
	let response = await reach(fetch(url, { headers, signal }));
	if (response.status === 401 || response.status === 403) {
		response = await fetch(url, { headers: anthropicHeaders(apiKey), signal });
	}
	if (!response.ok) throw new Error(`GET /v1/models: HTTP ${response.status}`);
	const body = parse(ModelList, await response.json(), "GET /v1/models");
	return [...new Set((body.data ?? []).map((model) => model.id))].sort();
}

export function customProvider(config: { id: string; name: string; baseUrl: string }, apiKey: string, modelIds: readonly string[], catalog: Catalog): Provider {
	return createProvider({
		id: config.id,
		name: config.name,
		auth: {
			apiKey: {
				name: "API key",
				resolve: async () => {
					if (apiKey) refuseCleartextSecret(config.baseUrl);
					return { auth: { apiKey } };
				},
			},
		},
		models: modelIds.map((id) => toModel(id, config.id, config.baseUrl, catalog)),
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"openai-responses": openAIResponsesApi(),
			"openai-completions": openAICompletionsApi(),
		},
	});
}

export function inCatalog(catalog: Catalog, id: string): boolean {
	return catalog.has(baseName(id));
}
