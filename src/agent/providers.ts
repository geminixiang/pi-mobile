// Model providers: the services the user's models come from, any number at once. A built-in provider is one of
// pi-ai's, with its catalog (context window, vision, reasoning, prices) and its API; the user gives its API key. A
// custom provider is any endpoint speaking the OpenAI or Anthropic API (a self-hosted gateway, Ollama, LM Studio),
// whose models come from its /v1/models (models.ts).
//
// Built-in providers are loaded only when configured: each is its own chunk with its catalog, and all catalogs are
// about 1 MB. BUILTIN_PROVIDERS lists those that work from the phone: their APIs answer the WebView's CORS preflight
// (checked 2026-10-21; NVIDIA's did not), and they need only an API key (Bedrock, Vertex, and Azure need more).
import type { Provider } from "@earendil-works/pi-ai";
import { withChatGPTSignIn } from "./chatgpt.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";

export interface BuiltinProviderInfo {
	/** pi-ai's provider id, also the id in conversations' model references. */
	id: string;
	name: string;
	/** Where the user gets an API key. */
	keyUrl: string;
	/** Also signs in with a ChatGPT subscription instead of a key (chatgpt.ts). */
	chatgpt?: true;
	load: () => Promise<Provider>;
}

export const BUILTIN_PROVIDERS: readonly BuiltinProviderInfo[] = [
	{
		id: "openai",
		name: "OpenAI",
		keyUrl: "https://platform.openai.com/api-keys",
		chatgpt: true,
		load: async () => withChatGPTSignIn((await import("@earendil-works/pi-ai/providers/openai")).openaiProvider()),
	},
	{ id: "anthropic", name: "Anthropic", keyUrl: "https://console.anthropic.com/settings/keys", load: async () => (await import("@earendil-works/pi-ai/providers/anthropic")).anthropicProvider() },
	{ id: "google", name: "Google Gemini", keyUrl: "https://aistudio.google.com/apikey", load: async () => (await import("@earendil-works/pi-ai/providers/google")).googleProvider() },
	{ id: "openrouter", name: "OpenRouter", keyUrl: "https://openrouter.ai/keys", load: async () => (await import("@earendil-works/pi-ai/providers/openrouter")).openrouterProvider() },
	{ id: "xai", name: "xAI", keyUrl: "https://console.x.ai", load: async () => (await import("@earendil-works/pi-ai/providers/xai")).xaiProvider() },
	{ id: "deepseek", name: "DeepSeek", keyUrl: "https://platform.deepseek.com/api_keys", load: async () => (await import("@earendil-works/pi-ai/providers/deepseek")).deepseekProvider() },
	{ id: "mistral", name: "Mistral", keyUrl: "https://console.mistral.ai/api-keys", load: async () => (await import("@earendil-works/pi-ai/providers/mistral")).mistralProvider() },
	{ id: "groq", name: "Groq", keyUrl: "https://console.groq.com/keys", load: async () => (await import("@earendil-works/pi-ai/providers/groq")).groqProvider() },
	{ id: "cerebras", name: "Cerebras", keyUrl: "https://cloud.cerebras.ai", load: async () => (await import("@earendil-works/pi-ai/providers/cerebras")).cerebrasProvider() },
	{ id: "together", name: "Together AI", keyUrl: "https://api.together.ai/settings/api-keys", load: async () => (await import("@earendil-works/pi-ai/providers/together")).togetherProvider() },
	{ id: "fireworks", name: "Fireworks", keyUrl: "https://fireworks.ai/account/api-keys", load: async () => (await import("@earendil-works/pi-ai/providers/fireworks")).fireworksProvider() },
	{ id: "moonshotai", name: "Moonshot AI", keyUrl: "https://platform.moonshot.ai/console/api-keys", load: async () => (await import("@earendil-works/pi-ai/providers/moonshotai")).moonshotaiProvider() },
	{ id: "huggingface", name: "Hugging Face", keyUrl: "https://huggingface.co/settings/tokens", load: async () => (await import("@earendil-works/pi-ai/providers/huggingface")).huggingfaceProvider() },
	{ id: "vercel-ai-gateway", name: "Vercel AI Gateway", keyUrl: "https://vercel.com/dashboard/ai-gateway", load: async () => (await import("@earendil-works/pi-ai/providers/vercel-ai-gateway")).vercelAIGatewayProvider() },
];

const ProviderConfig = Type.Union([
	Type.Object({ kind: Type.Literal("builtin"), id: Type.String() }),
	Type.Object({ kind: Type.Literal("custom"), id: Type.String(), name: Type.String(), baseUrl: Type.String() }),
]);
/** One configured provider; its API key is in the Keystore under its id (settings.ts). */
export type ProviderConfig = { kind: "builtin"; id: string } | { kind: "custom"; id: string; name: string; baseUrl: string };

export function parseProviders(json: string): ProviderConfig[] {
	try {
		const value: unknown = JSON.parse(json || "[]");
		return Array.isArray(value) ? value.filter((item): item is ProviderConfig => Value.Check(ProviderConfig, item)) : [];
	} catch {
		return [];
	}
}

export function builtinInfo(id: string): BuiltinProviderInfo | undefined {
	return BUILTIN_PROVIDERS.find((provider) => provider.id === id);
}

export function providerName(config: ProviderConfig): string {
	if (config.kind === "builtin") return builtinInfo(config.id)?.name ?? config.id;
	if (config.name.trim()) return config.name.trim();
	try {
		return new URL(config.baseUrl).host;
	} catch {
		return "自訂端點";
	}
}

/** An id for another custom provider: custom, then custom-2 and on. */
export function customId(taken: readonly ProviderConfig[]): string {
	const ids = taken.map((provider) => provider.id);
	if (!ids.includes("custom")) return "custom";
	for (let n = 2; ; n++) if (!ids.includes(`custom-${n}`)) return `custom-${n}`;
}

/** The provider id every conversation used before providers: the single model service, now the first custom one. */
export const LEGACY_PROVIDER_ID = "cliproxyapi";
