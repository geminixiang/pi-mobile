import { SecureStorage } from "@aparajita/capacitor-secure-storage";
import { type Static, Type } from "typebox";
import { DEFAULT_MODEL_ID } from "./agent/models.ts";
import { readStored } from "./agent/parse.ts";
import { log } from "./log.ts";
import { type ProviderConfig, parseProviders } from "./agent/providers.ts";
import { messageOf } from "./promise.ts";

const PLAIN_KEY = "pi-mobile.settings";
const DEFAULT_COMPACT_AT_TOKENS = 256_000;
const providerKey = (id: string) => `provider.${id}.apiKey`;
const providerOAuthKey = (id: string) => `provider.${id}.oauth`;
const SECRET_GITHUB_TOKEN = "github.token";
const SECRET_GCLOUD = "gcloud.credential";
const SECRET_CLOUDFLARE = "cloudflare.credential";
const SECRET_AZURE = "azure.credential";

export interface Settings {
	providers: string;
	providerKeys: Record<string, string>;
	providerOAuth: Record<string, string>;
	githubToken: string;
	gcloudCredential: string;
	gcloudProject: string;
	cloudflareCredential: string;
	azureCredential: string;
	defaultProvider: string;
	defaultModelId: string;
	defaultThinking: string;
	calendarAccess: string;
	hosts: string;
	computer: string;
	compactAt: number;
}

const PlainSettings = Type.Object({
	providers: Type.Optional(Type.String()),
	defaultProvider: Type.Optional(Type.String()),
	gcloudProject: Type.Optional(Type.String()),
	defaultModelId: Type.Optional(Type.String()),
	defaultThinking: Type.Optional(Type.String()),
	calendarAccess: Type.Optional(Type.String()),
	hosts: Type.Optional(Type.String()),
	computer: Type.Optional(Type.String()),
	compactAt: Type.Optional(Type.Number()),
});
type PlainSettings = Static<typeof PlainSettings>;

function loadPlain(): PlainSettings {
	return readStored(PlainSettings, PLAIN_KEY) ?? {};
}

const storedSecretKeys = new Set<string>();
const secretsAsLoaded = new Map<string, string>();
const secretsRotatedSinceLoad = new Map<string, string>();
const unreadableSecrets = new Set<string>();

async function readSecret(key: string): Promise<string> {
	secretsRotatedSinceLoad.delete(key);
	if (!storedSecretKeys.has(key)) {
		secretsAsLoaded.set(key, "");
		return "";
	}
	const value = await SecureStorage.get(key).then(
		(stored) => {
			unreadableSecrets.delete(key);
			return typeof stored === "string" ? stored : "";
		},
		(error: unknown) => {
			unreadableSecrets.add(key);
			log.warn("settings.secret_unreadable", { key, error: messageOf(error) });
			return "";
		},
	);
	secretsAsLoaded.set(key, value);
	return value;
}

async function writeSecret(key: string, value: string): Promise<void> {
	await SecureStorage.set(key, value);
	storedSecretKeys.add(key);
}

async function removeSecret(key: string): Promise<void> {
	if (!storedSecretKeys.has(key)) return;
	await SecureStorage.remove(key);
	storedSecretKeys.delete(key);
}

function keepRotated(key: string, value: string): string {
	const rotated = secretsRotatedSinceLoad.get(key);
	return rotated !== undefined && value === secretsAsLoaded.get(key) ? rotated : value;
}

async function saveRotatingSecret(key: string, value: string): Promise<void> {
	await writeSecret(key, value);
	secretsRotatedSinceLoad.set(key, value);
}

export async function loadSettings(): Promise<Settings> {
	const plain = loadPlain();
	storedSecretKeys.clear();
	for (const key of await SecureStorage.keys()) storedSecretKeys.add(key);
	const providers = parseProviders(plain.providers ?? "");
	const [keys, oauth, githubToken, gcloudCredential, cloudflareCredential, azureCredential] = await Promise.all([
		Promise.all(providers.map(async (provider) => [provider.id, await readSecret(providerKey(provider.id))] as const)),
		Promise.all(providers.map(async (provider) => [provider.id, await readSecret(providerOAuthKey(provider.id))] as const)),
		...[SECRET_GITHUB_TOKEN, SECRET_GCLOUD, SECRET_CLOUDFLARE, SECRET_AZURE].map(readSecret),
	]);
	return {
		providers: JSON.stringify(providers),
		providerKeys: Object.fromEntries(keys),
		providerOAuth: Object.fromEntries(oauth.filter(([, json]) => json)),
		defaultProvider: plain.defaultProvider || providers[0]?.id || "",
		githubToken,
		gcloudCredential,
		gcloudProject: plain.gcloudProject ?? "",
		cloudflareCredential,
		azureCredential,
		defaultModelId: plain.defaultModelId ?? DEFAULT_MODEL_ID,
		defaultThinking: plain.defaultThinking ?? "low",
		calendarAccess: plain.calendarAccess ?? "",
		hosts: plain.hosts ?? "",
		computer: plain.computer ?? "",
		compactAt: plain.compactAt ?? DEFAULT_COMPACT_AT_TOKENS,
	};
}

export async function saveSettings(edited: Settings): Promise<Settings> {
	const settings: Settings = {
		...edited,
		providerOAuth: Object.fromEntries(Object.entries(edited.providerOAuth).map(([id, json]) => [id, keepRotated(providerOAuthKey(id), json)])),
		cloudflareCredential: keepRotated(SECRET_CLOUDFLARE, edited.cloudflareCredential),
		azureCredential: keepRotated(SECRET_AZURE, edited.azureCredential),
	};
	const before = parseProviders(loadPlain().providers ?? "");
	const providers = parseProviders(settings.providers);
	const plain: PlainSettings = {
		providers: JSON.stringify(providers),
		defaultProvider: settings.defaultProvider,
		gcloudProject: settings.gcloudProject,
		defaultModelId: settings.defaultModelId,
		defaultThinking: settings.defaultThinking,
		calendarAccess: settings.calendarAccess,
		hosts: settings.hosts,
		computer: settings.computer,
		compactAt: settings.compactAt,
	};
	localStorage.setItem(PLAIN_KEY, JSON.stringify(plain));
	for (const provider of providers) {
		await saveSecret(providerKey(provider.id), settings.providerKeys[provider.id] ?? "");
		await saveSecret(providerOAuthKey(provider.id), settings.providerOAuth[provider.id] ?? "");
	}
	for (const provider of before.filter((old) => !providers.some((kept) => kept.id === old.id))) {
		await removeSecret(providerKey(provider.id));
		await removeSecret(providerOAuthKey(provider.id));
	}
	await saveSecret(SECRET_GITHUB_TOKEN, settings.githubToken);
	await saveSecret(SECRET_GCLOUD, settings.gcloudCredential);
	await saveSecret(SECRET_CLOUDFLARE, settings.cloudflareCredential);
	await saveSecret(SECRET_AZURE, settings.azureCredential);
	return settings;
}

async function saveSecret(key: string, value: string): Promise<void> {
	const wouldEraseUnreadSecret = !value && unreadableSecrets.has(key);
	if (wouldEraseUnreadSecret) return;
	unreadableSecrets.delete(key);
	if (value) await writeSecret(key, value);
	else await removeSecret(key);
	secretsAsLoaded.set(key, value);
	secretsRotatedSinceLoad.delete(key);
}

export function usableProviders(settings: Pick<Settings, "providers" | "providerKeys" | "providerOAuth">): ProviderConfig[] {
	return parseProviders(settings.providers).filter(
		(provider) => provider.kind === "custom" || Boolean(settings.providerKeys[provider.id] || settings.providerOAuth[provider.id]),
	);
}

export async function saveProviderOAuth(id: string, json: string): Promise<void> {
	await saveRotatingSecret(providerOAuthKey(id), json);
}

export function isConfigured(settings: Settings): boolean {
	return usableProviders(settings).length > 0;
}

export async function saveCloudflareCredential(json: string): Promise<void> {
	await saveRotatingSecret(SECRET_CLOUDFLARE, json);
}

export async function saveAzureCredential(json: string): Promise<void> {
	await saveRotatingSecret(SECRET_AZURE, json);
}
