// App settings. Secrets live in the Android Keystore / iOS Keychain through secure storage;
// the rest is plain localStorage.
import { SecureStorage } from "@aparajita/capacitor-secure-storage";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { DEFAULT_MODEL_ID } from "./agent/models.ts";
import { log } from "./log.ts";
import { type ProviderConfig, parseProviders } from "./agent/providers.ts";

const PLAIN_KEY = "pi-mobile.settings";
/** A bot's conversation never ends; compacting at 256k tokens keeps each request's cost bounded. */
export const DEFAULT_COMPACT_AT = 256_000;
/** The single model service's key, before providers: moved to the custom provider it becomes. */
const LEGACY_SECRET_API_KEY = "cliproxyapi.apiKey";
const providerKey = (id: string) => `provider.${id}.apiKey`;
const providerOAuthKey = (id: string) => `provider.${id}.oauth`;
const SECRET_GITHUB_TOKEN = "github.token";
const SECRET_SANDBOX_TOKEN = "sandbox.token";
const SECRET_GCLOUD = "gcloud.credential";
const SECRET_CLOUDFLARE = "cloudflare.credential";
const SECRET_AZURE = "azure.credential";

export interface Settings {
	/** Model providers, as JSON (agent/providers.ts); their keys are in providerKeys. */
	providers: string;
	/** API key per provider id, from the Keystore. */
	providerKeys: Record<string, string>;
	/** A subscription sign-in per provider id (Sign in with ChatGPT), as pi-ai credential JSON, from the Keystore. */
	providerOAuth: Record<string, string>;
	githubToken: string;
	/** Sandbox relay, e.g. ws://100.x.y.z:8787; empty disables the sandbox tools. */
	sandboxUrl: string;
	sandboxToken: string;
	/** Google Cloud credential JSON (authorized_user or service_account) for gcloud in the sandbox; empty disables it. */
	gcloudCredential: string;
	/** Default project for gcloud; empty uses the credential's own. */
	gcloudProject: string;
	/** Cloudflare credential JSON (OAuth sign-in or API token) for cf and wrangler in the sandbox. */
	cloudflareCredential: string;
	/** Azure credential JSON (device code sign-in) for az in the sandbox. */
	azureCredential: string;
	/** A new bot's model: a provider id and a model id. */
	defaultProvider: string;
	defaultModelId: string;
	defaultThinking: string;
	/** Which calendar accounts the agent may read and write, as JSON (agent/calendar-access.ts); empty for the defaults. */
	calendarAccess: string;
	/** The user's machines reached over SSH, as JSON (agent/sandbox/machine.ts); host keys are public, so plain. */
	machines: string;
	/** The machine whose tools the agent uses; empty uses the relay when one is set. */
	sandboxMachine: string;
	/** The user's computers running pi-host on the tailnet, as JSON (agent/sandbox/host.ts). */
	hosts: string;
	/** Context size in tokens at which a bot's conversation is compacted; 0 for the model's own limit. */
	compactAt: number;
	/** Approving a tool's action also takes the fingerprint, face, or screen lock. */
	approvalAuth: boolean;
}

/** The non-secret settings in localStorage. */
const PlainSettings = Type.Object({
	/** The single model service, before providers; read once to make the custom provider. */
	baseUrl: Type.Optional(Type.String()),
	providers: Type.Optional(Type.String()),
	defaultProvider: Type.Optional(Type.String()),
	sandboxUrl: Type.Optional(Type.String()),
	gcloudProject: Type.Optional(Type.String()),
	defaultModelId: Type.Optional(Type.String()),
	defaultThinking: Type.Optional(Type.String()),
	calendarAccess: Type.Optional(Type.String()),
	machines: Type.Optional(Type.String()),
	sandboxMachine: Type.Optional(Type.String()),
	hosts: Type.Optional(Type.String()),
	compactAt: Type.Optional(Type.Number()),
	approvalAuth: Type.Optional(Type.Boolean()),
});
type PlainSettings = Static<typeof PlainSettings>;

/** Stored plain settings; anything unreadable counts as unset rather than breaking startup. */
function loadPlain(): PlainSettings {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(PLAIN_KEY) ?? "{}");
		return Value.Check(PlainSettings, value) ? value : {};
	} catch {
		return {};
	}
}

const secretsAsLoaded = new Map<string, string>();
const secretsRotatedSinceLoad = new Map<string, string>();
const unreadableSecrets = new Set<string>();

async function secret(key: string): Promise<string> {
	let value: unknown;
	try {
		value = await SecureStorage.get(key);
		unreadableSecrets.delete(key);
	} catch (error) {
		unreadableSecrets.add(key);
		log.warn("settings.secret_unreadable", { key, error: error instanceof Error ? error.message : String(error) });
	}
	const text = typeof value === "string" ? value : "";
	secretsAsLoaded.set(key, text);
	secretsRotatedSinceLoad.delete(key);
	return text;
}

function keepRotated(key: string, value: string): string {
	const rotated = secretsRotatedSinceLoad.get(key);
	return rotated !== undefined && value === secretsAsLoaded.get(key) ? rotated : value;
}

async function saveRotatingSecret(key: string, value: string): Promise<void> {
	await SecureStorage.set(key, value);
	secretsRotatedSinceLoad.set(key, value);
}

export async function loadSettings(): Promise<Settings> {
	const plain = loadPlain();
	// At once, not one after another: each is a Keystore round trip, and they are on the way to the first screen.
	let providers = parseProviders(plain.providers ?? "");
	let defaultProvider = plain.defaultProvider ?? "";
	let legacyKey: string | undefined;
	if (plain.providers === undefined && plain.baseUrl) {
		// The model service of earlier versions becomes the first provider, a custom one.
		let name = plain.baseUrl;
		try {
			name = new URL(plain.baseUrl).host;
		} catch {
			// Not a URL: its text names it.
		}
		providers = [{ kind: "custom", id: "custom", name, baseUrl: plain.baseUrl }];
		defaultProvider = "custom";
		legacyKey = await secret(LEGACY_SECRET_API_KEY);
	}
	const [keys, oauth, githubToken, sandboxToken, gcloudCredential, cloudflareCredential, azureCredential] = await Promise.all([
		Promise.all(providers.map(async (provider) => [provider.id, await secret(providerKey(provider.id))] as const)),
		Promise.all(providers.map(async (provider) => [provider.id, await secret(providerOAuthKey(provider.id))] as const)),
		...[SECRET_GITHUB_TOKEN, SECRET_SANDBOX_TOKEN, SECRET_GCLOUD, SECRET_CLOUDFLARE, SECRET_AZURE].map(secret),
	]);
	const providerKeys: Record<string, string> = Object.fromEntries(keys);
	if (legacyKey !== undefined) providerKeys.custom = legacyKey;
	return {
		providers: JSON.stringify(providers),
		providerKeys,
		providerOAuth: Object.fromEntries(oauth.filter(([, json]) => json)),
		defaultProvider: defaultProvider || providers[0]?.id || "",
		githubToken,
		sandboxUrl: plain.sandboxUrl ?? "",
		sandboxToken,
		gcloudCredential,
		gcloudProject: plain.gcloudProject ?? "",
		cloudflareCredential,
		azureCredential,
		defaultModelId: plain.defaultModelId ?? DEFAULT_MODEL_ID,
		defaultThinking: plain.defaultThinking ?? "low",
		calendarAccess: plain.calendarAccess ?? "",
		machines: plain.machines ?? "",
		sandboxMachine: plain.sandboxMachine ?? "",
		hosts: plain.hosts ?? "",
		compactAt: plain.compactAt ?? DEFAULT_COMPACT_AT,
		approvalAuth: plain.approvalAuth ?? false,
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
		sandboxUrl: settings.sandboxUrl,
		gcloudProject: settings.gcloudProject,
		defaultModelId: settings.defaultModelId,
		defaultThinking: settings.defaultThinking,
		calendarAccess: settings.calendarAccess,
		machines: settings.machines,
		sandboxMachine: settings.sandboxMachine,
		hosts: settings.hosts,
		compactAt: settings.compactAt,
		approvalAuth: settings.approvalAuth,
	};
	localStorage.setItem(PLAIN_KEY, JSON.stringify(plain));
	for (const provider of providers) {
		await saveSecret(providerKey(provider.id), settings.providerKeys[provider.id] ?? "");
		await saveSecret(providerOAuthKey(provider.id), settings.providerOAuth[provider.id] ?? "");
	}
	for (const provider of before) {
		if (providers.some((kept) => kept.id === provider.id)) continue;
		await SecureStorage.remove(providerKey(provider.id)).catch(() => false);
		await SecureStorage.remove(providerOAuthKey(provider.id)).catch(() => false);
	}
	await SecureStorage.remove(LEGACY_SECRET_API_KEY).catch(() => false);
	await saveSecret(SECRET_GITHUB_TOKEN, settings.githubToken);
	await saveSecret(SECRET_SANDBOX_TOKEN, settings.sandboxToken);
	await saveSecret(SECRET_GCLOUD, settings.gcloudCredential);
	await saveSecret(SECRET_CLOUDFLARE, settings.cloudflareCredential);
	await saveSecret(SECRET_AZURE, settings.azureCredential);
	return settings;
}

async function saveSecret(key: string, value: string): Promise<void> {
	if (!value && unreadableSecrets.has(key)) return;
	unreadableSecrets.delete(key);
	if (value) await SecureStorage.set(key, value);
	else await SecureStorage.remove(key).catch(() => false);
	secretsAsLoaded.set(key, value);
	secretsRotatedSinceLoad.delete(key);
}

/** A provider that can answer: a built-in one with its key, or a custom one (a local server may need none). */
export function usableProviders(settings: Pick<Settings, "providers" | "providerKeys" | "providerOAuth">): ProviderConfig[] {
	return parseProviders(settings.providers).filter(
		(provider) => provider.kind === "custom" || Boolean(settings.providerKeys[provider.id] || settings.providerOAuth[provider.id]),
	);
}

/** A refreshed sign-in, written at once: the old refresh token may already be spent. */
export async function saveProviderOAuth(id: string, json: string): Promise<void> {
	await saveRotatingSecret(providerOAuthKey(id), json);
}

export function isConfigured(settings: Settings): boolean {
	return usableProviders(settings).length > 0;
}

/** Cloudflare rotates refresh tokens on every refresh; the new one replaces the stored credential right away. */
export async function saveCloudflareCredential(json: string): Promise<void> {
	await saveRotatingSecret(SECRET_CLOUDFLARE, json);
}

/** Microsoft may rotate the refresh token on refresh; the new one replaces the stored credential right away. */
export async function saveAzureCredential(json: string): Promise<void> {
	await saveRotatingSecret(SECRET_AZURE, json);
}
