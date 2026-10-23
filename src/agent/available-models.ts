import { createModels } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { type Settings, saveProviderOAuth, usableProviders } from "../settings.ts";
import { messageOf, orLogged } from "../promise.ts";
import { chatgptModelsCached, parseOAuthCredential, withOnlyModels } from "./chatgpt.ts";
import { gatewayCatalog, memoryCredentials } from "./credentials.ts";
import { customProvider, describe, fetchModelIds, inCatalog, type ModelInfo, withCompaction } from "./models.ts";
import { readStored } from "./parse.ts";
import { builtinInfo, type ProviderConfig, parseProviders, providerName } from "./providers.ts";

function webSearchConfig(configs: readonly ProviderConfig[], keys: Record<string, string>, lists: Record<string, string[]>, infos: readonly ModelInfo[]) {
	const custom = configs.find((config) => config.kind === "custom");
	if (custom?.kind === "custom") return { baseUrl: custom.baseUrl, apiKey: keys[custom.id] ?? "", modelIds: lists[custom.id] ?? [] };
	const ids = (provider: string) => infos.filter((info) => info.provider === provider).map((info) => info.id);
	const keyed = (provider: string) => configs.some((config) => config.id === provider) && Boolean(keys[provider]);
	if (keyed("openai")) return { baseUrl: "https://api.openai.com", apiKey: keys.openai ?? "", modelIds: ids("openai") };
	if (keyed("anthropic")) return { baseUrl: "https://api.anthropic.com", apiKey: keys.anthropic ?? "", modelIds: ids("anthropic") };
	return { baseUrl: "", apiKey: "", modelIds: [] };
}

export function startModelList(settings: Settings): Promise<Record<string, string[]>> {
	const lists = parseProviders(settings.providers)
		.filter((provider) => provider.kind === "custom")
		.map(async (provider): Promise<[string, string[]]> => {
			if (provider.kind !== "custom") return [provider.id, []];
			const key = `pi-mobile.models:${provider.baseUrl}`;
			const fresh = fetchModelIds(provider.baseUrl, settings.providerKeys[provider.id] ?? "", AbortSignal.timeout(5000)).then((ids) => {
				if (ids.length > 0) localStorage.setItem(key, JSON.stringify(ids));
				return ids;
			});
			const refreshed = orLogged(fresh, "models.refresh_failed", [], { provider: provider.id });
			const cached = readStored(Type.Array(Type.String()), key) ?? [];
			return [provider.id, cached.length > 0 ? cached : await refreshed];
		});
	return Promise.all(lists).then(Object.fromEntries);
}

export async function loadModels(
	settings: Settings,
	modelIds: Promise<Record<string, string[]>>,
	onReport?: (message: string) => void,
) {
	const compactAt = settings.compactAt;
	const configs = usableProviders(settings);
	const [lists, loaded, catalog] = await Promise.all([
		modelIds.catch((error: unknown): Record<string, string[]> => {
			onReport?.(`model list unavailable: ${messageOf(error)}`);
			return {};
		}),
		Promise.all(
			configs.map(async (config) => {
				if (config.kind !== "builtin") return undefined;
				const provider = await builtinInfo(config.id)?.load();
				const signIn = parseOAuthCredential(settings.providerOAuth[config.id] ?? "");
				if (!provider || !signIn) return provider;
				const allowed = await chatgptModelsCached(signIn);
				return allowed ? withOnlyModels(provider, allowed) : provider;
			}),
		),
		gatewayCatalog(configs),
	]);
	const credentials = memoryCredentials(
		Object.fromEntries(configs.map((config) => [config.id, settings.providerKeys[config.id] ?? ""])),
		settings.providerOAuth,
		(id, json) => void orLogged(saveProviderOAuth(id, json), "provider.oauth_save_failed", undefined, { id }),
	);
	const models = createModels({ credentials });
	const infos: ModelInfo[] = [];
	configs.forEach((config, index) => {
		const name = providerName(config);
		if (config.kind === "custom") {
			const ids = lists[config.id] ?? [];
			const provider = customProvider(config, settings.providerKeys[config.id] ?? "", ids, catalog);
			models.setProvider(withCompaction(provider, compactAt));
			for (const model of provider.getModels()) infos.push(describe(model, name, compactAt, inCatalog(catalog, model.id)));
			return;
		}
		const provider = loaded[index];
		if (!provider) return;
		models.setProvider(withCompaction(provider, compactAt));
		for (const model of provider.getModels()) infos.push(describe(model, name, compactAt));
	});
	return { models, infos, lists, webSearch: webSearchConfig(configs, settings.providerKeys, lists, infos) };
}
