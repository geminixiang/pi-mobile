// Google Cloud credentials for the sandbox's gcloud. The long-lived credential (a user refresh token from signing in,
// or a service account key) stays on the phone; only short-lived access tokens it mints go to the relay, on request,
// for the egress proxy to inject.
import { type Static, Type } from "typebox";
import { type AccessToken, base64url, jwtPayload, postForm, tokensFrom } from "./oauth.ts";
import { parse, parseJson } from "./parse.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

const AuthorizedUser = Type.Object({
	type: Type.Literal("authorized_user"),
	client_id: Type.String(),
	client_secret: Type.String(),
	refresh_token: Type.String(),
	quota_project_id: Type.Optional(Type.String()),
	/** Recorded at sign-in in the app, for display. */
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

/** Parse stored or pasted credential JSON; the message suits the settings screen. */
export function parseCredential(json: string): Credential {
	const value = parseJson(json, "Google 憑證");
	try {
		return parse(Credential, value, "Google 憑證");
	} catch {
		throw new Error("需要 authorized_user（用 Google 登入，或 gcloud auth application-default login 產生）或 service_account 金鑰");
	}
}

/** Who the credential acts as and its project, for the settings screen. */
export function describeCredential(credential: Credential): string {
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

/** A JWT assertion for the service account's token grant, signed RS256 with WebCrypto. */
async function serviceAccountAssertion(credential: Static<typeof ServiceAccount>): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const encode = (value: object) => base64url(new TextEncoder().encode(JSON.stringify(value)));
	const header = encode({ alg: "RS256", typ: "JWT" });
	const claims = encode({ iss: credential.client_email, scope: SCOPE, aud: credential.token_uri ?? TOKEN_URL, iat: now, exp: now + 3600 });
	const pem = credential.private_key.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
	const der = Uint8Array.from(atob(pem), (char) => char.charCodeAt(0));
	const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
	const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`));
	return `${header}.${claims}.${base64url(signature)}`;
}

async function exchange(credential: Credential): Promise<AccessToken> {
	const response =
		credential.type === "authorized_user"
			? await postForm({
					url: TOKEN_URL,
					form: {
						grant_type: "refresh_token",
						refresh_token: credential.refresh_token,
						client_id: credential.client_id,
						client_secret: credential.client_secret,
					},
					what: "Google token",
				})
			: await postForm({
					url: credential.token_uri ?? TOKEN_URL,
					form: { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: await serviceAccountAssertion(credential) },
					what: "Google token",
				});
	return tokensFrom(response, "Google token").access;
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

// ---------- Sign in with Google ----------
//
// The same flow as `gcloud auth application-default login --no-launch-browser`: gcloud's public OAuth client for
// application default credentials, PKCE, and Google's page on sdk.cloud.google.com that shows the authorization code
// for the user to copy back. The result is the authorized_user credential that command would write.

const ADC_CLIENT_ID = "764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com";
const ADC_CLIENT_SECRET = "d-FL95Q19q7MQmFpd7hHD0Ty";
const ADC_REDIRECT_URI = "https://sdk.cloud.google.com/applicationdefaultauthcode.html";
const SIGN_IN_SCOPES = ["openid", "https://www.googleapis.com/auth/userinfo.email", SCOPE];

export interface GoogleSignIn {
	url: string;
	/** PKCE verifier for the code exchange; keep it until the user brings the code back. */
	verifier: string;
}

export async function startGoogleSignIn(): Promise<GoogleSignIn> {
	const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
	const challenge = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
	const url = new URL("https://accounts.google.com/o/oauth2/auth");
	url.search = new URLSearchParams({
		response_type: "code",
		client_id: ADC_CLIENT_ID,
		redirect_uri: ADC_REDIRECT_URI,
		scope: SIGN_IN_SCOPES.join(" "),
		state: base64url(crypto.getRandomValues(new Uint8Array(16))),
		prompt: "consent",
		token_usage: "remote",
		access_type: "offline",
		code_challenge: challenge,
		code_challenge_method: "S256",
	}).toString();
	return { url: url.href, verifier };
}

/** Whether clipboard text looks like the authorization code Google's page shows (e.g. 4/0Ab...). */
export function looksLikeAuthCode(text: string): boolean {
	return /^4\/[0-9A-Za-z_-]{20,}$/.test(text.trim());
}

const IdClaims = Type.Object({ email: Type.Optional(Type.String()) });

/** Exchange the code for the credential JSON to store; it records the signed-in account for display. */
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
	const tokens = tokensFrom(response, "Google 登入");
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
