// App settings. Secrets live in the Android Keystore / iOS Keychain through secure storage;
// the rest is plain localStorage.
import { SecureStorage } from "@aparajita/capacitor-secure-storage";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { DEFAULT_MODEL_ID } from "./agent/models.ts";

const PLAIN_KEY = "pi-mobile.settings";
/** A bot's conversation never ends; compacting at 128k tokens keeps each request's cost bounded. */
export const DEFAULT_COMPACT_AT = 128_000;
/** Keychain key from the first version; kept so saved keys still load. */
const SECRET_API_KEY = "cliproxyapi.apiKey";
const SECRET_GITHUB_TOKEN = "github.token";
const SECRET_SANDBOX_TOKEN = "sandbox.token";
const SECRET_GCLOUD = "gcloud.credential";
const SECRET_CLOUDFLARE = "cloudflare.credential";
const SECRET_AZURE = "azure.credential";

export interface Settings {
	baseUrl: string;
	apiKey: string;
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
	defaultModelId: string;
	defaultThinking: string;
	/** Which calendar accounts the agent may read and write, as JSON (agent/calendar-access.ts); empty for the defaults. */
	calendarAccess: string;
	/** The user's machines reached over SSH, as JSON (agent/sandbox/machine.ts); host keys are public, so plain. */
	machines: string;
	/** The machine whose tools the agent uses; empty uses the relay when one is set. */
	sandboxMachine: string;
	/** Context size in tokens at which a bot's conversation is compacted; 0 for the model's own limit. */
	compactAt: number;
}

/** The non-secret settings in localStorage. */
const PlainSettings = Type.Object({
	baseUrl: Type.Optional(Type.String()),
	sandboxUrl: Type.Optional(Type.String()),
	gcloudProject: Type.Optional(Type.String()),
	defaultModelId: Type.Optional(Type.String()),
	defaultThinking: Type.Optional(Type.String()),
	calendarAccess: Type.Optional(Type.String()),
	machines: Type.Optional(Type.String()),
	sandboxMachine: Type.Optional(Type.String()),
	compactAt: Type.Optional(Type.Number()),
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

async function secret(key: string): Promise<string> {
	const value = await SecureStorage.get(key).catch(() => null);
	return typeof value === "string" ? value : "";
}

export async function loadSettings(): Promise<Settings> {
	const plain = loadPlain();
	// At once, not one after another: each is a Keystore round trip, and they are on the way to the first screen.
	const [apiKey, githubToken, sandboxToken, gcloudCredential, cloudflareCredential, azureCredential] = await Promise.all(
		[SECRET_API_KEY, SECRET_GITHUB_TOKEN, SECRET_SANDBOX_TOKEN, SECRET_GCLOUD, SECRET_CLOUDFLARE, SECRET_AZURE].map(secret),
	);
	return {
		baseUrl: plain.baseUrl ?? "",
		apiKey,
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
		compactAt: plain.compactAt ?? DEFAULT_COMPACT_AT,
	};
}

export async function saveSettings(settings: Settings): Promise<void> {
	const plain: PlainSettings = {
		baseUrl: settings.baseUrl,
		sandboxUrl: settings.sandboxUrl,
		gcloudProject: settings.gcloudProject,
		defaultModelId: settings.defaultModelId,
		defaultThinking: settings.defaultThinking,
		calendarAccess: settings.calendarAccess,
		machines: settings.machines,
		sandboxMachine: settings.sandboxMachine,
		compactAt: settings.compactAt,
	};
	localStorage.setItem(PLAIN_KEY, JSON.stringify(plain));
	await SecureStorage.set(SECRET_API_KEY, settings.apiKey);
	await saveSecret(SECRET_GITHUB_TOKEN, settings.githubToken);
	await saveSecret(SECRET_SANDBOX_TOKEN, settings.sandboxToken);
	await saveSecret(SECRET_GCLOUD, settings.gcloudCredential);
	await saveSecret(SECRET_CLOUDFLARE, settings.cloudflareCredential);
	await saveSecret(SECRET_AZURE, settings.azureCredential);
}

async function saveSecret(key: string, value: string): Promise<void> {
	if (value) await SecureStorage.set(key, value);
	else await SecureStorage.remove(key).catch(() => false);
}

export function isConfigured(settings: Settings): boolean {
	return Boolean(settings.baseUrl && settings.apiKey);
}

/** Cloudflare rotates refresh tokens on every refresh; the new one replaces the stored credential right away. */
export async function saveCloudflareCredential(json: string): Promise<void> {
	await SecureStorage.set(SECRET_CLOUDFLARE, json);
}

/** Microsoft may rotate the refresh token on refresh; the new one replaces the stored credential right away. */
export async function saveAzureCredential(json: string): Promise<void> {
	await SecureStorage.set(SECRET_AZURE, json);
}
