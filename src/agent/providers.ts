import type { Provider } from "@earendil-works/pi-ai";
import { withChatGPTSignIn } from "./chatgpt.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { decode } from "./parse.ts";

export interface BuiltinProviderInfo {
	id: string;
	name: string;
	keyUrl: string;
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
export type ProviderConfig = { kind: "builtin"; id: string } | { kind: "custom"; id: string; name: string; baseUrl: string };

export function parseProviders(json: string): ProviderConfig[] {
	return (decode(Type.Array(Type.Unknown()), json) ?? []).filter((item): item is ProviderConfig => Value.Check(ProviderConfig, item));
}

export function builtinInfo(id: string): BuiltinProviderInfo | undefined {
	return BUILTIN_PROVIDERS.find((provider) => provider.id === id);
}

export function providerName(config: ProviderConfig): string {
	if (config.kind === "builtin") return builtinInfo(config.id)?.name ?? config.id;
	if (config.name.trim()) return config.name.trim();
	return URL.canParse(config.baseUrl) ? new URL(config.baseUrl).host : "自訂端點";
}

export function customId(taken: readonly ProviderConfig[]): string {
	const ids = taken.map((provider) => provider.id);
	if (!ids.includes("custom")) return "custom";
	for (let n = 2; ; n++) if (!ids.includes(`custom-${n}`)) return `custom-${n}`;
}
