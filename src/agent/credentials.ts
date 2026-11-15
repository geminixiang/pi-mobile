import { type Api, type Credential, type CredentialStore, InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { parseOAuthCredential } from "./chatgpt.ts";
import type { Catalog } from "./models.ts";
import { BUILTIN_PROVIDERS, type ProviderConfig } from "./providers.ts";

export async function memoryCredentials(
	keys: Record<string, string>,
	signIns: Record<string, string>,
	onSignIn: (providerId: string, json: string) => void = () => undefined,
): Promise<CredentialStore> {
	const store = new InMemoryCredentialStore();
	const apiKeys = Object.entries(keys).flatMap(([id, key]): [string, Credential][] => (key ? [[id, { type: "api_key", key }]] : []));
	const oauth = Object.entries(signIns).flatMap(([id, json]): [string, Credential][] => {
		const credential = parseOAuthCredential(json);
		return credential ? [[id, credential]] : [];
	});
	await Promise.all([...apiKeys, ...oauth].map(([id, credential]) => store.modify(id, async () => credential)));
	return {
		read: (providerId, options) => store.read(providerId, options),
		list: (options) => store.list(options),
		delete: (providerId, options) => store.delete(providerId, options),
		modify: (providerId, fn, options) =>
			store.modify(
				providerId,
				async (current) => {
					const next = await fn(current);
					if (next?.type === "oauth") onSignIn(providerId, JSON.stringify(next));
					return next;
				},
				options,
			),
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
