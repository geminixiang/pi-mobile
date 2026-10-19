// Google Cloud credentials for the sandbox's gcloud. The long-lived credential (a user refresh token from
// `gcloud auth application-default login`, or a service account key) stays on the phone; only short-lived access
// tokens it mints go to the relay, on request, for the egress proxy to inject.
import { CapacitorHttp } from "@capacitor/core";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

type Credential =
	| { type: "authorized_user"; client_id: string; client_secret: string; refresh_token: string; quota_project_id?: string }
	| { type: "service_account"; client_email: string; private_key: string; project_id?: string; token_uri?: string };

export interface AccessToken {
	token: string;
	/** Milliseconds since the epoch. */
	expiresAt: number;
}

/** Parse pasted credential JSON; throws a message for the settings screen when it is not one we can use. */
export function parseCredential(json: string): Credential {
	let value: Record<string, unknown>;
	try {
		value = JSON.parse(json) as Record<string, unknown>;
	} catch {
		throw new Error("不是有效的 JSON");
	}
	if (value.type === "authorized_user" && value.refresh_token && value.client_id && value.client_secret) return value as Credential;
	if (value.type === "service_account" && value.client_email && value.private_key) return value as Credential;
	throw new Error("需要 authorized_user（gcloud auth application-default login 產生）或 service_account 金鑰");
}

/** Who the credential acts as and its project, for the settings screen. */
export function describeCredential(credential: Credential): string {
	return credential.type === "service_account"
		? `${credential.client_email}${credential.project_id ? ` · ${credential.project_id}` : ""}`
		: `使用者憑證${credential.quota_project_id ? ` · ${credential.quota_project_id}` : ""}`;
}

function base64url(data: ArrayBuffer | string): string {
	const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A JWT assertion for the service account's token grant, signed RS256 with WebCrypto. */
async function serviceAccountAssertion(credential: Extract<Credential, { type: "service_account" }>): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const claims = base64url(
		JSON.stringify({ iss: credential.client_email, scope: SCOPE, aud: credential.token_uri ?? TOKEN_URL, iat: now, exp: now + 3600 }),
	);
	const pem = credential.private_key.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
	const der = Uint8Array.from(atob(pem), (char) => char.charCodeAt(0));
	const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
	const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`));
	return `${header}.${claims}.${base64url(signature)}`;
}

async function exchange(credential: Credential): Promise<AccessToken> {
	const form =
		credential.type === "authorized_user"
			? new URLSearchParams({
					grant_type: "refresh_token",
					refresh_token: credential.refresh_token,
					client_id: credential.client_id,
					client_secret: credential.client_secret,
				})
			: new URLSearchParams({
					grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
					assertion: await serviceAccountAssertion(credential),
				});
	// Native HTTP: Google's token endpoint does not allow the WebView's origin.
	const response = await CapacitorHttp.post({
		url: credential.type === "service_account" ? (credential.token_uri ?? TOKEN_URL) : TOKEN_URL,
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		data: form.toString(),
	});
	const body = (typeof response.data === "string" ? JSON.parse(response.data) : response.data) as {
		access_token?: string;
		expires_in?: number;
		error?: string;
		error_description?: string;
	};
	if (response.status !== 200 || !body.access_token) {
		throw new Error(`Google token: ${body.error_description ?? body.error ?? `HTTP ${response.status}`}`);
	}
	return { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
}

/** Mints and caches access tokens; a token is reused until five minutes before it expires. */
export class GcloudTokens {
	readonly #credential: Credential;
	#cached: AccessToken | undefined;
	#pending: Promise<AccessToken> | undefined;

	constructor(json: string) {
		this.#credential = parseCredential(json);
	}

	get(): Promise<AccessToken> {
		if (this.#cached && this.#cached.expiresAt - Date.now() > 5 * 60_000) return Promise.resolve(this.#cached);
		this.#pending ??= exchange(this.#credential)
			.then((token) => {
				this.#cached = token;
				return token;
			})
			.finally(() => {
				this.#pending = undefined;
			});
		return this.#pending;
	}

	/** The credential's own project, used as the default when settings name none. */
	get project(): string | undefined {
		return this.#credential.type === "service_account" ? this.#credential.project_id : this.#credential.quota_project_id;
	}
}

/** Settings check: mint a token and report who it acts as. */
export async function checkGcloud(json: string): Promise<string> {
	const credential = parseCredential(json);
	await exchange(credential);
	return describeCredential(credential);
}
