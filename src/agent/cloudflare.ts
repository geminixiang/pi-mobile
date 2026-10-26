import { type Static, Type } from "typebox";
import { type AccessToken, cachedToken, type DeviceSignIn, getJson, pollDeviceFlow, postForm, refreshedTokens, startDeviceFlow } from "./oauth.ts";
import { type Checked, check, checkJson, parse } from "./parse.ts";
import { orLogged } from "../promise.ts";

const AUTH_DOMAIN = "https://dash.cloudflare.com";
const TOKEN_URL = `${AUTH_DOMAIN}/oauth2/token`;
const CLIENT_ID = "cbca97e7-c331-4cdd-8fd8-e25a451b98bf";
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
type CloudflareCredential = Static<typeof CloudflareCredential>;

const UserResponse = Type.Object({ result: Type.Optional(Type.Object({ email: Type.Optional(Type.String()) })) });
const AccountsResponse = Type.Object({
	result: Type.Optional(Type.Array(Type.Object({ id: Type.String(), name: Type.String() }))),
});

export function checkCloudflareCredential(json: string): Checked<CloudflareCredential> {
	return checkJson(CloudflareCredential, json, "Cloudflare 憑證");
}

export function describeCloudflare(json: string): string {
	const checked = checkCloudflareCredential(json);
	if (!checked.ok) return checked.problem;
	const credential = checked.value;
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

export function apiTokenCredential(token: string): string {
	return JSON.stringify({ type: "cloudflare_api_token", token: token.trim() } satisfies Static<typeof ApiTokenCredential>);
}

export async function startCloudflareSignIn(): Promise<DeviceSignIn> {
	const signIn = await startDeviceFlow({
		url: `${AUTH_DOMAIN}/oauth2/device/auth`,
		form: { client_id: CLIENT_ID, scope: SCOPES.join(" ") },
		what: "Cloudflare 登入",
	});
	if (new URL(signIn.url).origin !== AUTH_DOMAIN) throw new Error(`Cloudflare 回傳了不信任的登入網址：${signIn.url}`);
	return signIn;
}

async function accountDetail<T extends Parameters<typeof parse>[0]>(token: string, path: string, schema: T): Promise<Static<T> | undefined> {
	const response = await orLogged(getJson({ url: `https://api.cloudflare.com/client/v4${path}`, token, what: "Cloudflare API" }), "cloudflare.account_detail_unavailable", undefined, { path });
	const checked = response && check(schema, response.body, "Cloudflare API");
	return checked?.ok ? checked.value : undefined;
}

export async function finishCloudflareSignIn(signIn: DeviceSignIn, signal: AbortSignal): Promise<string> {
	const tokens = await pollDeviceFlow({ signIn, url: TOKEN_URL, form: { client_id: CLIENT_ID }, what: "Cloudflare", signal });
	if (!tokens.refresh) throw new Error("Cloudflare 登入失敗：沒有拿到 refresh token");
	const user = await accountDetail(tokens.access.token, "/user", UserResponse);
	const account = (await accountDetail(tokens.access.token, "/accounts?per_page=5", AccountsResponse))?.result?.[0];
	return JSON.stringify({
		type: "cloudflare_oauth",
		refresh_token: tokens.refresh,
		email: user?.result?.email,
		account_id: account?.id,
		account_name: account?.name,
	} satisfies Static<typeof OAuthCredential>);
}

export class CloudflareTokens {
	#credential: CloudflareCredential;
	readonly #onRotate: (json: string) => Promise<void>;
	readonly #oauth = cachedToken((credential: Static<typeof OAuthCredential>) => this.#refresh(credential));

	constructor(credential: CloudflareCredential, onRotate: (json: string) => Promise<void>) {
		this.#credential = credential;
		this.#onRotate = onRotate;
	}

	get accountId(): string | undefined {
		return this.#credential.account_id;
	}

	get(): Promise<AccessToken> {
		const credential = this.#credential;
		if (credential.type === "cloudflare_api_token") return Promise.resolve({ token: credential.token, expiresAt: Date.now() + 24 * 3600_000 });
		return this.#oauth(credential);
	}

	async #refresh(credential: Static<typeof OAuthCredential>): Promise<AccessToken> {
		const response = await postForm({
			url: TOKEN_URL,
			form: { grant_type: "refresh_token", refresh_token: credential.refresh_token, client_id: CLIENT_ID },
			what: "Cloudflare token",
		});
		const tokens = refreshedTokens(response, "Cloudflare token");
		if (tokens.refresh && tokens.refresh !== credential.refresh_token) {
			this.#credential = { ...credential, refresh_token: tokens.refresh };
			await this.#onRotate(JSON.stringify(this.#credential));
		}
		return tokens.access;
	}
}
