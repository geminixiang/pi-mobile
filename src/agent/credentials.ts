import type { Api, Credential, CredentialStore, Model } from "@earendil-works/pi-ai";
import { parseOAuthCredential } from "./chatgpt.ts";
import type { Catalog } from "./models.ts";
import { BUILTIN_PROVIDERS, type ProviderConfig } from "./providers.ts";
import { serially } from "../promise.ts";

export function memoryCredentials(
	keys: Record<string, string>,
	signIns: Record<string, string>,
	onSignIn: (providerId: string, json: string) => void = () => undefined,
): CredentialStore {
	const store = new Map<string, Credential>(Object.entries(keys).filter(([, key]) => key).map(([id, key]) => [id, { type: "api_key", key }]));
	for (const [id, json] of Object.entries(signIns)) {
		const credential = parseOAuthCredential(json);
		if (credential) store.set(id, credential);
	}
	const queued = serially();
	return {
		read: async (providerId) => store.get(providerId),
		list: async () => [...store].map(([providerId, credential]) => ({ providerId, type: credential.type })),
		modify: (providerId, fn) =>
			queued(async () => {
				const value = await fn(store.get(providerId));
				if (value) store.set(providerId, value);
				else store.delete(providerId);
				if (value?.type === "oauth") onSignIn(providerId, JSON.stringify(value));
				return value;
			}),
		delete: async (providerId) => {
			store.delete(providerId);
		},
	};
}

const GATEWAY_CATALOGS = ["anthropic", "openai", "google"];

export async function gatewayCatalog(configs: readonly ProviderConfig[]): Promise<Catalog> {
	if (!configs.some((config) => config.kind === "custom")) return new Map();
	const providers = await Promise.all(
		BUILTIN_PROVIDERS.filter((info) => GATEWAY_CATALOGS.includes(info.id)).map((info) => info.load()),
	);
	const catalog = new Map<string, Model<Api>>();
	for (const provider of providers) for (const model of provider.getModels()) if (!catalog.has(model.id)) catalog.set(model.id, model);
	return catalog;
}
