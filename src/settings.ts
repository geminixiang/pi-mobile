// App settings. Secrets live in the Android Keystore / iOS Keychain through secure storage;
// the rest is plain localStorage.
import { SecureStorage } from "@aparajita/capacitor-secure-storage";

const PLAIN_KEY = "pi-mobile.settings";
/** Keychain key from the first version; kept so saved keys still load. */
const SECRET_API_KEY = "cliproxyapi.apiKey";
const SECRET_GITHUB_TOKEN = "github.token";
const SECRET_SANDBOX_TOKEN = "sandbox.token";
const SECRET_GCLOUD = "gcloud.credential";
const SECRET_CLOUDFLARE = "cloudflare.credential";

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
	defaultModelId: string;
	defaultThinking: string;
}

interface PlainSettings {
	baseUrl?: string;
	sandboxUrl?: string;
	gcloudProject?: string;
	defaultModelId?: string;
	defaultThinking?: string;
}

async function secret(key: string): Promise<string> {
	const value = await SecureStorage.get(key).catch(() => null);
	return typeof value === "string" ? value : "";
}

export async function loadSettings(): Promise<Settings> {
	const plain = JSON.parse(localStorage.getItem(PLAIN_KEY) ?? "{}") as PlainSettings;
	return {
		baseUrl: plain.baseUrl ?? "",
		apiKey: await secret(SECRET_API_KEY),
		githubToken: await secret(SECRET_GITHUB_TOKEN),
		sandboxUrl: plain.sandboxUrl ?? "",
		sandboxToken: await secret(SECRET_SANDBOX_TOKEN),
		gcloudCredential: await secret(SECRET_GCLOUD),
		gcloudProject: plain.gcloudProject ?? "",
		cloudflareCredential: await secret(SECRET_CLOUDFLARE),
		defaultModelId: plain.defaultModelId ?? "claude-opus-5-5",
		defaultThinking: plain.defaultThinking ?? "low",
	};
}

export async function saveSettings(settings: Settings): Promise<void> {
	const plain: PlainSettings = {
		baseUrl: settings.baseUrl,
		sandboxUrl: settings.sandboxUrl,
		gcloudProject: settings.gcloudProject,
		defaultModelId: settings.defaultModelId,
		defaultThinking: settings.defaultThinking,
	};
	localStorage.setItem(PLAIN_KEY, JSON.stringify(plain));
	await SecureStorage.set(SECRET_API_KEY, settings.apiKey);
	await saveSecret(SECRET_GITHUB_TOKEN, settings.githubToken);
	await saveSecret(SECRET_SANDBOX_TOKEN, settings.sandboxToken);
	await saveSecret(SECRET_GCLOUD, settings.gcloudCredential);
	await saveSecret(SECRET_CLOUDFLARE, settings.cloudflareCredential);
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
