// Azure credentials for az in the sandbox. Sign-in is Microsoft's device code flow with the Azure CLI's public client:
// the app shows a code (and copies it), the user enters it at microsoft.com/devicelogin, the app polls. The refresh
// token stays on the phone; the relay asks for access tokens per resource (ARM, Graph, Key Vault) when the proxy needs
// one. In the sandbox, az is signed in as a managed identity whose endpoint is the relay and hands out placeholders.
import { CapacitorHttp } from "@capacitor/core";
import type { AccessToken } from "./gcloud.ts";

const TIMEOUTS = { connectTimeout: 10_000, readTimeout: 20_000 };
const LOGIN = "https://login.microsoftonline.com";
/** The Azure CLI's public client. */
const CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46";
const ARM_SCOPE = "https://management.core.windows.net//.default";

export interface AzureCredential {
	type: "azure";
	refresh_token: string;
	tenant_id: string;
	tenant_name?: string;
	username?: string;
	subscription_id?: string;
	subscription_name?: string;
}

type Json = Record<string, unknown>;

async function post(url: string, form: Record<string, string>): Promise<Json> {
	const response = await CapacitorHttp.post({
		url,
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		data: new URLSearchParams(form).toString(),
		...TIMEOUTS,
	});
	return (typeof response.data === "string" ? JSON.parse(response.data || "{}") : response.data) as Json;
}

async function arm(token: string, path: string): Promise<Json> {
	const response = await CapacitorHttp.get({
		url: `https://management.azure.com${path}`,
		headers: { Authorization: `Bearer ${token}` },
		...TIMEOUTS,
	});
	return (typeof response.data === "string" ? JSON.parse(response.data) : response.data) as Json;
}

export function parseAzure(json: string): AzureCredential {
	const value = JSON.parse(json) as AzureCredential;
	if (value.type !== "azure" || !value.refresh_token || !value.tenant_id) throw new Error("不是 Azure 憑證");
	return value;
}

export function describeAzure(json: string): string {
	try {
		const credential = parseAzure(json);
		return [credential.username, credential.subscription_name ?? credential.tenant_name].filter(Boolean).join(" · ");
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

export interface AzureDeviceSignIn {
	userCode: string;
	/** microsoft.com/devicelogin; Microsoft's flow has no URL with the code filled in. */
	url: string;
	deviceCode: string;
	intervalMs: number;
	expiresAt: number;
}

export async function startAzureSignIn(): Promise<AzureDeviceSignIn> {
	const body = await post(`${LOGIN}/organizations/oauth2/v2.0/devicecode`, {
		client_id: CLIENT_ID,
		scope: `${ARM_SCOPE} offline_access openid profile`,
	});
	if (typeof body.device_code !== "string") throw new Error(`Azure 登入失敗：${String(body.error_description ?? body.error)}`);
	return {
		userCode: String(body.user_code),
		url: String(body.verification_uri ?? "https://microsoft.com/devicelogin"),
		deviceCode: body.device_code,
		intervalMs: Number(body.interval ?? 5) * 1000,
		expiresAt: Date.now() + Number(body.expires_in ?? 900) * 1000,
	};
}

/** Poll until the user enters the code; then pick the tenant and subscription az will use. */
export async function finishAzureSignIn(signIn: AzureDeviceSignIn, signal: AbortSignal): Promise<string> {
	let interval = signIn.intervalMs;
	while (Date.now() < signIn.expiresAt) {
		await new Promise((resolve) => setTimeout(resolve, interval));
		if (signal.aborted) throw new Error("已取消");
		let body: Json;
		try {
			body = await post(`${LOGIN}/organizations/oauth2/v2.0/token`, {
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				device_code: signIn.deviceCode,
				client_id: CLIENT_ID,
			});
		} catch {
			continue; // A network drop while the user is in the browser.
		}
		if (body.error === "authorization_pending") continue;
		if (body.error === "slow_down") {
			interval += 5000;
			continue;
		}
		if (typeof body.access_token !== "string" || typeof body.refresh_token !== "string") {
			throw new Error(`Azure 登入失敗：${String(body.error_description ?? body.error ?? "沒有拿到 token")}`);
		}
		const claims = JSON.parse(atob(String(body.id_token ?? body.access_token).split(".")[1]?.replace(/-/g, "+").replace(/_/g, "/") ?? "")) as {
			tid?: string;
			preferred_username?: string;
			upn?: string;
		};
		// The first subscription decides the tenant; without one, the sign-in's own tenant.
		const subscriptions = ((await arm(body.access_token, "/subscriptions?api-version=2022-12-01")).value ?? []) as {
			subscriptionId: string;
			displayName: string;
			tenantId: string;
		}[];
		const subscription = subscriptions[0];
		const tenant = subscription?.tenantId ?? claims.tid ?? "";
		return JSON.stringify({
			type: "azure",
			refresh_token: body.refresh_token,
			tenant_id: tenant,
			username: claims.preferred_username ?? claims.upn,
			subscription_id: subscription?.subscriptionId,
			subscription_name: subscription?.displayName,
		} satisfies AzureCredential);
	}
	throw new Error("登入逾時，請再試一次");
}

/** Access tokens per resource scope; Microsoft may rotate the refresh token, which `onRotate` persists. */
export class AzureTokens {
	#credential: AzureCredential;
	readonly #onRotate: (json: string) => Promise<void>;
	readonly #cache = new Map<string, AccessToken>();
	readonly #pending = new Map<string, Promise<AccessToken>>();

	constructor(json: string, onRotate: (json: string) => Promise<void>) {
		this.#credential = parseAzure(json);
		this.#onRotate = onRotate;
	}

	/** What the sandbox's placeholder tokens and az's profile need: tenant and subscription. */
	get env(): Record<string, string> {
		return {
			AZURE_TENANT_ID: this.#credential.tenant_id,
			...(this.#credential.subscription_id ? { AZURE_SUBSCRIPTION_ID: this.#credential.subscription_id } : {}),
		};
	}

	get(scope = ARM_SCOPE): Promise<AccessToken> {
		const cached = this.#cache.get(scope);
		if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return Promise.resolve(cached);
		let pending = this.#pending.get(scope);
		if (!pending) {
			pending = this.#refresh(scope).finally(() => this.#pending.delete(scope));
			this.#pending.set(scope, pending);
		}
		return pending;
	}

	async #refresh(scope: string): Promise<AccessToken> {
		const credential = this.#credential;
		const body = await post(`${LOGIN}/${credential.tenant_id}/oauth2/v2.0/token`, {
			grant_type: "refresh_token",
			refresh_token: credential.refresh_token,
			client_id: CLIENT_ID,
			scope: `${scope} offline_access`,
		});
		if (typeof body.access_token !== "string") {
			throw new Error(`Azure token：${String(body.error_description ?? body.error)}（可能需要在設定重新登入）`);
		}
		if (typeof body.refresh_token === "string" && body.refresh_token !== credential.refresh_token) {
			this.#credential = { ...credential, refresh_token: body.refresh_token };
			await this.#onRotate(JSON.stringify(this.#credential));
		}
		const token = { token: body.access_token, expiresAt: Date.now() + Number(body.expires_in ?? 3600) * 1000 };
		this.#cache.set(scope, token);
		return token;
	}
}
