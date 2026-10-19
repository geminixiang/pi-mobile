// Cloudflare credentials for cf and wrangler in the sandbox. Sign-in is the OAuth device flow of Cloudflare's `cf`
// CLI (its public client ID): the app shows a code, the user approves it in the browser, the app polls for tokens.
// The refresh token stays on the phone; the relay only ever gets short-lived access tokens. An API token pasted in
// settings works too and is passed on as is.
import { CapacitorHttp } from "@capacitor/core";

/**
 * Native HTTP has no timeouts by default: a request sent while the network drops (common right after switching
 * apps) can wait forever, and a sign-in that polls would wait with it.
 */
const TIMEOUTS = { connectTimeout: 10_000, readTimeout: 20_000 };
import type { AccessToken } from "./gcloud.ts";

const AUTH_DOMAIN = "https://dash.cloudflare.com";
const CLIENT_ID = "cbca97e7-c331-4cdd-8fd8-e25a451b98bf";
/** The scopes `cf auth login` asks for by default, minus ones only Cloudflare staff can grant. */
const SCOPES = [
	"account:read",
	"user:read",
	"zone:read",
	"dns_records:read",
	"dns_records:edit",
	"workers:read",
	"workers:write",
	"workers_scripts:write",
	"workers_routes:write",
	"workers_kv:write",
	"workers_tail:read",
	"pages:read",
	"pages:write",
	"d1:write",
	"queues:write",
	"r2_catalog:write",
	"ssl_certs:write",
	"ai:read",
	"ai:write",
	"secrets_store:read",
	"secrets_store:write",
	"containers:write",
	"workers_observability:read",
	"offline_access",
];

export type CloudflareCredential =
	| { type: "cloudflare_oauth"; refresh_token: string; email?: string; account_id?: string; account_name?: string }
	| { type: "cloudflare_api_token"; token: string; account_id?: string };

type Json = Record<string, unknown>;

async function post(path: string, form: Record<string, string>): Promise<{ status: number; body: Json }> {
	// Native HTTP: the OAuth endpoints do not allow the WebView's origin.
	const response = await CapacitorHttp.post({
		url: `${AUTH_DOMAIN}${path}`,
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		data: new URLSearchParams(form).toString(),
		...TIMEOUTS,
	});
	const body = (typeof response.data === "string" ? JSON.parse(response.data || "{}") : response.data) as Json;
	return { status: response.status, body };
}

async function api(token: string, path: string): Promise<Json> {
	const response = await CapacitorHttp.get({
		url: `https://api.cloudflare.com/client/v4${path}`,
		headers: { Authorization: `Bearer ${token}` },
		...TIMEOUTS,
	});
	return (typeof response.data === "string" ? JSON.parse(response.data) : response.data) as Json;
}

export function parseCloudflare(json: string): CloudflareCredential {
	const value = JSON.parse(json) as CloudflareCredential;
	if (value.type === "cloudflare_oauth" && value.refresh_token) return value;
	if (value.type === "cloudflare_api_token" && value.token) return value;
	throw new Error("不是 Cloudflare 憑證");
}

/** What settings show for a stored credential. */
export function describeCloudflare(json: string): string {
	try {
		const credential = parseCloudflare(json);
		if (credential.type === "cloudflare_api_token") return `API token${credential.account_id ? ` · ${credential.account_id.slice(0, 8)}…` : ""}`;
		return [credential.email ?? "OAuth 登入", credential.account_name].filter(Boolean).join(" · ");
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/** An API token pasted in settings, stored in the same shape as a sign-in. */
export function apiTokenCredential(token: string): string {
	return JSON.stringify({ type: "cloudflare_api_token", token: token.trim() });
}

// ---------- Device flow sign-in ----------

export interface DeviceSignIn {
	userCode: string;
	/** Page that approves this code, with the code filled in. */
	url: string;
	deviceCode: string;
	intervalMs: number;
	expiresAt: number;
}

export async function startDeviceSignIn(): Promise<DeviceSignIn> {
	const { status, body } = await post("/oauth2/device/auth", { client_id: CLIENT_ID, scope: SCOPES.join(" ") });
	if (status !== 200 || typeof body.device_code !== "string") throw new Error(`Cloudflare 登入失敗：${String(body.error_description ?? body.error ?? status)}`);
	const url = String(body.verification_uri_complete ?? body.verification_uri);
	// Only open Cloudflare's own page, as cf does.
	if (new URL(url).origin !== AUTH_DOMAIN) throw new Error(`Cloudflare 回傳了不信任的登入網址：${url}`);
	return {
		userCode: String(body.user_code),
		url,
		deviceCode: body.device_code,
		intervalMs: Number(body.interval ?? 5) * 1000,
		expiresAt: Date.now() + Number(body.expires_in ?? 300) * 1000,
	};
}

/** Poll until the user approves the code; resolves with the credential JSON to store. */
export async function finishDeviceSignIn(signIn: DeviceSignIn, signal: AbortSignal): Promise<string> {
	let interval = signIn.intervalMs;
	while (Date.now() < signIn.expiresAt) {
		await new Promise((resolve) => setTimeout(resolve, interval));
		if (signal.aborted) throw new Error("已取消");
		let body: Json;
		try {
			({ body } = await post("/oauth2/token", {
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				device_code: signIn.deviceCode,
				client_id: CLIENT_ID,
			}));
		} catch {
			// The phone's network drops for a moment while the user is in the browser; keep polling until the code expires.
			continue;
		}
		if (body.error === "authorization_pending") continue;
		if (body.error === "slow_down") {
			interval += 5000;
			continue;
		}
		if (body.error === "access_denied") throw new Error("你在 Cloudflare 拒絕了授權");
		if (typeof body.access_token !== "string" || typeof body.refresh_token !== "string") {
			throw new Error(`Cloudflare 登入失敗：${String(body.error_description ?? body.error ?? "沒有拿到 token")}`);
		}
		// Who signed in, and the first account, so cf and wrangler know which account to use.
		const user = await api(body.access_token, "/user").catch(() => ({}) as Json);
		const accounts = await api(body.access_token, "/accounts?per_page=5").catch(() => ({}) as Json);
		const account = (accounts.result as { id: string; name: string }[] | undefined)?.[0];
		return JSON.stringify({
			type: "cloudflare_oauth",
			refresh_token: body.refresh_token,
			email: (user.result as { email?: string } | undefined)?.email,
			account_id: account?.id,
			account_name: account?.name,
		});
	}
	throw new Error("登入逾時，請再試一次");
}

// ---------- Access tokens ----------

/**
 * Mints access tokens from the stored credential. Cloudflare rotates refresh tokens: every refresh returns a new one
 * and retires the old, so `onRotate` must persist it before the next refresh.
 */
export class CloudflareTokens {
	#credential: CloudflareCredential;
	readonly #onRotate: (json: string) => Promise<void>;
	#cached: AccessToken | undefined;
	#pending: Promise<AccessToken> | undefined;

	constructor(json: string, onRotate: (json: string) => Promise<void>) {
		this.#credential = parseCloudflare(json);
		this.#onRotate = onRotate;
	}

	get accountId(): string | undefined {
		return this.#credential.account_id;
	}

	get(): Promise<AccessToken> {
		const credential = this.#credential;
		if (credential.type === "cloudflare_api_token") return Promise.resolve({ token: credential.token, expiresAt: Date.now() + 24 * 3600_000 });
		if (this.#cached && this.#cached.expiresAt - Date.now() > 5 * 60_000) return Promise.resolve(this.#cached);
		this.#pending ??= this.#refresh(credential).finally(() => {
			this.#pending = undefined;
		});
		return this.#pending;
	}

	async #refresh(credential: Extract<CloudflareCredential, { type: "cloudflare_oauth" }>): Promise<AccessToken> {
		const { status, body } = await post("/oauth2/token", {
			grant_type: "refresh_token",
			refresh_token: credential.refresh_token,
			client_id: CLIENT_ID,
		});
		if (status !== 200 || typeof body.access_token !== "string") {
			throw new Error(`Cloudflare token：${String(body.error_description ?? body.error ?? `HTTP ${status}`)}（可能需要在設定重新登入）`);
		}
		if (typeof body.refresh_token === "string" && body.refresh_token !== credential.refresh_token) {
			this.#credential = { ...credential, refresh_token: body.refresh_token };
			await this.#onRotate(JSON.stringify(this.#credential));
		}
		this.#cached = { token: body.access_token, expiresAt: Date.now() + Number(body.expires_in ?? 3600) * 1000 };
		return this.#cached;
	}
}
