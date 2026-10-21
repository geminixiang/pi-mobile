// pi-ai's side of the model providers: the credential store it resolves API keys from, and the catalog a custom
// endpoint's models are looked up in.
import type { Api, Credential, CredentialStore, Model } from "@earendil-works/pi-ai";
import { parseOAuthCredential } from "./chatgpt.ts";
import type { Catalog } from "./models.ts";
import { BUILTIN_PROVIDERS, type ProviderConfig } from "./providers.ts";

/**
 * Credentials by provider id, in memory: they come from the Keystore with the settings. A subscription sign-in wins
 * over a key. pi-ai writes only when it refreshes a sign-in; `onSignIn` persists that at once, since the old refresh
 * token may already be spent.
 */
export function memoryCredentials(
	keys: Record<string, string>,
	signIns: Record<string, string> = {},
	onSignIn: (providerId: string, json: string) => void = () => undefined,
): CredentialStore {
	const store = new Map<string, Credential>(Object.entries(keys).filter(([, key]) => key).map(([id, key]) => [id, { type: "api_key", key }]));
	for (const [id, json] of Object.entries(signIns)) {
		const credential = parseOAuthCredential(json);
		if (credential) store.set(id, credential);
	}
	let queue: Promise<unknown> = Promise.resolve();
	return {
		read: async (providerId) => store.get(providerId),
		list: async () => [...store].map(([providerId, credential]) => ({ providerId, type: credential.type })),
		modify: (providerId, fn) => {
			const next = queue.then(async () => {
				const value = await fn(store.get(providerId));
				if (value) store.set(providerId, value);
				else store.delete(providerId);
				if (value?.type === "oauth") onSignIn(providerId, JSON.stringify(value));
				return value;
			});
			queue = next.catch(() => undefined);
			return next;
		},
		delete: async (providerId) => {
			store.delete(providerId);
		},
	};
}

/** Providers whose catalogs name the models a gateway usually serves. */
const GATEWAY_CATALOGS = ["anthropic", "openai", "google"];

/**
 * With a custom provider configured, the catalogs of the providers whose models gateways serve, by model id; the
 * chunks load in parallel with everything else at start. Empty without one.
 */
export async function gatewayCatalog(configs: readonly ProviderConfig[]): Promise<Catalog> {
	if (!configs.some((config) => config.kind === "custom")) return new Map();
	const providers = await Promise.all(
		BUILTIN_PROVIDERS.filter((info) => GATEWAY_CATALOGS.includes(info.id)).map((info) => info.load().catch(() => undefined)),
	);
	const catalog = new Map<string, Model<Api>>();
	for (const provider of providers) for (const model of provider?.getModels() ?? []) if (!catalog.has(model.id)) catalog.set(model.id, model);
	return catalog;
}
