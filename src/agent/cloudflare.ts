// Cloudflare credentials for cf and wrangler in the sandbox. Sign-in is the OAuth device flow of Cloudflare's `cf`
// CLI (its public client ID): the app shows a code, the user approves it in the browser, the app polls for tokens.
// The refresh token stays on the phone; the relay only ever gets short-lived access tokens. An API token pasted in
// settings works too and is passed on as is.
import { type Static, Type } from "typebox";
import { type AccessToken, type DeviceSignIn, getJson, pollDeviceFlow, postForm, startDeviceFlow, tokensFrom } from "./oauth.ts";
import { parse, parseJson } from "./parse.ts";

const AUTH_DOMAIN = "https://dash.cloudflare.com";
const TOKEN_URL = `${AUTH_DOMAIN}/oauth2/token`;
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

const OAuthCredential = Type.Object({
	type: Type.Literal("cloudflare_oauth"),
	refresh_token: Type.String(),
	email: Type.Optional(Type.String()),
	account_id: Type.Optional(Type.String()),
	account_name: Type.Optional(Type.String()),
});
const ApiTokenCredential = Type.Object({
	type: Type.Literal("cloudflare_api_token"),
	token: Type.String(),
	account_id: Type.Optional(Type.String()),
});
const CloudflareCredential = Type.Union([OAuthCredential, ApiTokenCredential]);
export type CloudflareCredential = Static<typeof CloudflareCredential>;

/** Cloudflare's API envelope, with only the fields read here. */
const UserResponse = Type.Object({ result: Type.Optional(Type.Object({ email: Type.Optional(Type.String()) })) });
const AccountsResponse = Type.Object({
	result: Type.Optional(Type.Array(Type.Object({ id: Type.String(), name: Type.String() }))),
});

export function parseCloudflare(json: string): CloudflareCredential {
	return parse(CloudflareCredential, parseJson(json, "Cloudflare 憑證"), "Cloudflare 憑證");
}

/** What settings show for a stored credential. */
export function describeCloudflare(json: string): string {
	let credential: CloudflareCredential;
	try {
		credential = parseCloudflare(json);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	switch (credential.type) {
		case "cloudflare_api_token":
			return `API token${credential.account_id ? ` · ${credential.account_id.slice(0, 8)}…` : ""}`;
		case "cloudflare_oauth":
			return [credential.email ?? "OAuth 登入", credential.account_name].filter(Boolean).join(" · ");
		default: {
			const _exhaustive: never = credential;
			return _exhaustive;
		}
	}
}

/** An API token pasted in settings, stored in the same shape as a sign-in. */
export function apiTokenCredential(token: string): string {
	return JSON.stringify({ type: "cloudflare_api_token", token: token.trim() } satisfies Static<typeof ApiTokenCredential>);
}

export type { DeviceSignIn };

export async function startDeviceSignIn(): Promise<DeviceSignIn> {
	const signIn = await startDeviceFlow({
		url: `${AUTH_DOMAIN}/oauth2/device/auth`,
		form: { client_id: CLIENT_ID, scope: SCOPES.join(" ") },
		what: "Cloudflare 登入",
	});
	// Only open Cloudflare's own page, as cf does.
	if (new URL(signIn.url).origin !== AUTH_DOMAIN) throw new Error(`Cloudflare 回傳了不信任的登入網址：${signIn.url}`);
	return signIn;
}

async function api<T extends Parameters<typeof parse>[0]>(token: string, path: string, schema: T): Promise<Static<T> | undefined> {
	try {
		const response = await getJson({ url: `https://api.cloudflare.com/client/v4${path}`, token, what: "Cloudflare API" });
		return parse(schema, response.body, "Cloudflare API");
	} catch {
		return undefined; // Display details only; sign-in does not depend on them.
	}
}

/** Poll until the user approves the code; resolves with the credential JSON to store. */
export async function finishDeviceSignIn(signIn: DeviceSignIn, signal: AbortSignal): Promise<string> {
	const tokens = await pollDeviceFlow({ signIn, url: TOKEN_URL, form: { client_id: CLIENT_ID }, what: "Cloudflare", signal });
	if (!tokens.refresh) throw new Error("Cloudflare 登入失敗：沒有拿到 refresh token");
	// Who signed in, and the first account, so cf and wrangler know which account to use.
	const user = await api(tokens.access.token, "/user", UserResponse);
	const account = (await api(tokens.access.token, "/accounts?per_page=5", AccountsResponse))?.result?.[0];
	return JSON.stringify({
		type: "cloudflare_oauth",
		refresh_token: tokens.refresh,
		email: user?.result?.email,
		account_id: account?.id,
		account_name: account?.name,
	} satisfies Static<typeof OAuthCredential>);
}

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

	async #refresh(credential: Static<typeof OAuthCredential>): Promise<AccessToken> {
		const response = await postForm({
			url: TOKEN_URL,
			form: { grant_type: "refresh_token", refresh_token: credential.refresh_token, client_id: CLIENT_ID },
			what: "Cloudflare token",
		});
		let tokens;
		try {
			tokens = tokensFrom(response, "Cloudflare token");
		} catch (error) {
			throw new Error(`${error instanceof Error ? error.message : String(error)}（可能需要在設定重新登入）`);
		}
		if (tokens.refresh && tokens.refresh !== credential.refresh_token) {
			this.#credential = { ...credential, refresh_token: tokens.refresh };
			await this.#onRotate(JSON.stringify(this.#credential));
		}
		this.#cached = tokens.access;
		return tokens.access;
	}
}
