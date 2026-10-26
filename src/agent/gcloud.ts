import { Value } from "typebox/value";
import { type Static, Type } from "typebox";
import { type AccessToken, cachedToken, checkTokens, jwtPayload, pkce, postForm } from "./oauth.ts";
import { type Checked, checkJson, parse, valueOrThrow } from "./parse.ts";
import { fromBase64, toBase64Url } from "../encoding.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

const AuthorizedUser = Type.Object({
	type: Type.Literal("authorized_user"),
	client_id: Type.String(),
	client_secret: Type.String(),
	refresh_token: Type.String(),
	quota_project_id: Type.Optional(Type.String()),
	account: Type.Optional(Type.String()),
});

const ServiceAccount = Type.Object({
	type: Type.Literal("service_account"),
	client_email: Type.String(),
	private_key: Type.String(),
	project_id: Type.Optional(Type.String()),
	token_uri: Type.Optional(Type.String()),
});

const Credential = Type.Union([AuthorizedUser, ServiceAccount]);
type Credential = Static<typeof Credential>;

const EXPECTED_CREDENTIAL = "需要 authorized_user（用 Google 登入，或 gcloud auth application-default login 產生）或 service_account 金鑰";

export function checkGcloudCredential(json: string): Checked<Credential> {
	const value = checkJson(Type.Unknown(), json, "Google 憑證");
	if (!value.ok) return value;
	return Value.Check(Credential, value.value) ? { ok: true, value: value.value } : { ok: false, problem: EXPECTED_CREDENTIAL };
}

export function describeGcloud(json: string): string {
	const checked = checkGcloudCredential(json);
	return checked.ok ? describeCredential(checked.value) : checked.problem;
}

function describeCredential(credential: Credential): string {
	switch (credential.type) {
		case "service_account":
			return `${credential.client_email}${credential.project_id ? ` · ${credential.project_id}` : ""}`;
		case "authorized_user":
			return `${credential.account ?? "使用者憑證"}${credential.quota_project_id ? ` · ${credential.quota_project_id}` : ""}`;
		default: {
			const _exhaustive: never = credential;
			return _exhaustive;
		}
	}
}

async function serviceAccountAssertion(credential: Static<typeof ServiceAccount>): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const encode = (value: object) => toBase64Url(new TextEncoder().encode(JSON.stringify(value)));
	const header = encode({ alg: "RS256", typ: "JWT" });
	const claims = encode({ iss: credential.client_email, scope: SCOPE, aud: credential.token_uri ?? TOKEN_URL, iat: now, exp: now + 3600 });
	const pem = credential.private_key.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
	const der = fromBase64(pem);
	const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
	const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`));
	return `${header}.${claims}.${toBase64Url(signature)}`;
}

async function exchange(credential: Credential): Promise<AccessToken> {
	const request: { url: string; form: Record<string, string> } =
		credential.type === "authorized_user"
			? {
					url: TOKEN_URL,
					form: { grant_type: "refresh_token", refresh_token: credential.refresh_token, client_id: credential.client_id, client_secret: credential.client_secret },
				}
			: {
					url: credential.token_uri ?? TOKEN_URL,
					form: { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: await serviceAccountAssertion(credential) },
				};
	const response = await postForm({ ...request, what: "Google token" });
	return valueOrThrow(checkTokens(response, "Google token")).access;
}

export class GcloudTokens {
	readonly #credential: Credential;
	readonly get = cachedToken(() => exchange(this.#credential));

	constructor(credential: Credential) {
		this.#credential = credential;
	}

	get project(): string | undefined {
		return this.#credential.type === "service_account" ? this.#credential.project_id : this.#credential.quota_project_id;
	}
}

export async function checkGcloud(json: string): Promise<string> {
	const credential = valueOrThrow(checkGcloudCredential(json));
	await exchange(credential);
	return describeCredential(credential);
}

const ADC_CLIENT_ID = "764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com";
const ADC_CLIENT_SECRET = "d-FL95Q19q7MQmFpd7hHD0Ty";
const ADC_REDIRECT_URI = "https://sdk.cloud.google.com/applicationdefaultauthcode.html";
const SIGN_IN_SCOPES = ["openid", "https://www.googleapis.com/auth/userinfo.email", SCOPE];

export interface GoogleSignIn {
	url: string;
	verifier: string;
}

export async function startGoogleSignIn(): Promise<GoogleSignIn> {
	const { verifier, challenge } = await pkce(48);
	const url = new URL("https://accounts.google.com/o/oauth2/auth");
	url.search = new URLSearchParams({
		response_type: "code",
		client_id: ADC_CLIENT_ID,
		redirect_uri: ADC_REDIRECT_URI,
		scope: SIGN_IN_SCOPES.join(" "),
		state: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
		prompt: "consent",
		token_usage: "remote",
		access_type: "offline",
		code_challenge: challenge,
		code_challenge_method: "S256",
	}).toString();
	return { url: url.href, verifier };
}

export function looksLikeAuthCode(text: string): boolean {
	return /^4\/[0-9A-Za-z_-]{20,}$/.test(text.trim());
}

const IdClaims = Type.Object({ email: Type.Optional(Type.String()) });

export async function finishGoogleSignIn(signIn: GoogleSignIn, code: string): Promise<string> {
	const response = await postForm({
		url: TOKEN_URL,
		form: {
			grant_type: "authorization_code",
			code: code.trim(),
			client_id: ADC_CLIENT_ID,
			client_secret: ADC_CLIENT_SECRET,
			redirect_uri: ADC_REDIRECT_URI,
			code_verifier: signIn.verifier,
		},
		what: "Google 登入",
	});
	const tokens = valueOrThrow(checkTokens(response, "Google 登入"));
	if (!tokens.refresh) throw new Error("Google 登入失敗：沒有拿到 refresh token");
	const claims = tokens.idToken ? parse(IdClaims, jwtPayload(tokens.idToken), "Google ID token") : {};
	return JSON.stringify({
		type: "authorized_user",
		client_id: ADC_CLIENT_ID,
		client_secret: ADC_CLIENT_SECRET,
		refresh_token: tokens.refresh,
		...(claims.email ? { account: claims.email } : {}),
	} satisfies Static<typeof AuthorizedUser>);
}
