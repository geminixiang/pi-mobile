import { listenForRedirect } from "../loopback-plugin.ts";
import type { Api, ApiStreamOptions, Model, OAuthAuth, OAuthCredential, Provider, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { streamFetch } from "../stream-fetch.ts";
import { Type } from "typebox";
import { pkce, postForm } from "./oauth.ts";
import { decode, parse, readStored } from "./parse.ts";
import { orLogged } from "../promise.ts";
import { toBase64Url } from "../encoding.ts";

const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const RESOURCE = "https://api.openai.com/v1";
const CLIENT_ID = "dynamic_agent_client";
const AGENT_NAME = "pi mobile";
const PORT = 1455;
const PATH = "/auth/callback";
const REDIRECT_URI = `http://127.0.0.1:${PORT}${PATH}`;
const DIRECT_TOKEN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${DIRECT_TOKEN_SCOPE}`;
const EXPIRY_MARGIN_MS = 3 * 60_000;
const WAIT_MS = 10 * 60_000;
const DEVICE_KEY = "pi-mobile.device-id";

const TokenResponse = Type.Object({
	access_token: Type.String({ minLength: 1 }),
	refresh_token: Type.String({ minLength: 1 }),
	scope: Type.String(),
	expires_in: Type.Number({ exclusiveMinimum: 0 }),
	id_token: Type.Optional(Type.String()),
});

function deviceId(): string {
	const stored = localStorage.getItem(DEVICE_KEY);
	if (stored) return stored;
	const id = crypto.randomUUID();
	localStorage.setItem(DEVICE_KEY, id);
	return id;
}

const random = () => toBase64Url(crypto.getRandomValues(new Uint8Array(32)));

async function requestToken(form: Record<string, string>, clientId: string): Promise<OAuthCredential> {
	const response = await postForm({ url: TOKEN_URL, form, what: "ChatGPT token" });
	if (response.status !== 200) throw new Error(`ChatGPT token: HTTP ${response.status} ${JSON.stringify(response.body).slice(0, 200)}`);
	const token = parse(TokenResponse, response.body, "ChatGPT token");
	const scopes = token.scope.trim().split(/\s+/).filter(Boolean);
	if (!scopes.includes(DIRECT_TOKEN_SCOPE)) throw new Error(`the grant did not include ${DIRECT_TOKEN_SCOPE}`);
	return {
		type: "oauth",
		access: token.access_token,
		refresh: token.refresh_token,
		expires: Date.now() + token.expires_in * 1000 - EXPIRY_MARGIN_MS,
		clientId,
		scopes,
	};
}

export async function signInWithChatGPT(openUrl: (url: string) => Promise<void>): Promise<OAuthCredential> {
	const { verifier, challenge } = await pkce(32);
	const state = random();
	const { promise: callback, resolve, reject } = Promise.withResolvers<URL>();
	const stop = await listenForRedirect({ port: PORT, path: PATH }, resolve);
	const timer = setTimeout(() => reject(new Error("沒有完成登入")), WAIT_MS);
	try {
		const authorize = new URL(AUTHORIZE_URL);
		authorize.search = new URLSearchParams({
			client_id: CLIENT_ID,
			agent_name_hint: AGENT_NAME,
			ext_agent_host_id: `urn:uuid:${deviceId()}`,
			response_type: "code",
			redirect_uri: REDIRECT_URI,
			resource: RESOURCE,
			scope: SCOPE,
			state,
			code_challenge: challenge,
			code_challenge_method: "S256",
			nonce: random(),
		}).toString();
		await openUrl(authorize.toString());
		const url = await callback;
		const error = url.searchParams.get("error");
		if (error) throw new Error(`ChatGPT 登入失敗：${error}`);
		if (url.searchParams.get("state") !== state) throw new Error("ChatGPT 登入失敗：state 不符");
		const code = url.searchParams.get("code");
		const clientId = url.searchParams.get("client_id")?.trim();
		if (!code || !clientId) throw new Error("ChatGPT 登入失敗：回呼缺少授權碼或 client id");
		return await requestToken(
			{ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT_URI, resource: RESOURCE },
			clientId,
		);
	} finally {
		clearTimeout(timer);
		await orLogged(stop(), "chatgpt.loopback_stop_failed", undefined);
	}
}

const chatgptOAuth: OAuthAuth = {
	name: "OpenAI (ChatGPT subscription)",
	isSubscription: true,
	loginLabel: "Sign in with ChatGPT",
	login: () => Promise.reject(new Error("sign in from settings (signInWithChatGPT)")),
	refresh: async (credential) => {
		const clientId = typeof credential.clientId === "string" ? credential.clientId : "";
		if (!clientId) throw new Error("the stored ChatGPT sign-in has no client id; sign in again");
		return requestToken({ grant_type: "refresh_token", client_id: clientId, refresh_token: credential.refresh, resource: RESOURCE }, clientId);
	},
	toAuth: async (credential) => ({ apiKey: credential.access }),
};

export function withChatGPTSignIn(provider: Provider): Provider {
	const wrapped: Provider = Object.create(provider);
	return Object.defineProperties(wrapped, {
		auth: { value: { ...provider.auth, oauth: chatgptOAuth }, enumerable: true },
		stream: { value: (model: Model<Api>, context: TranscriptContext, options?: ApiStreamOptions<Api>) => provider.stream(model, context, { ...options, fetch: options?.fetch ?? streamFetch }) },
		streamSimple: { value: (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => provider.streamSimple(model, context, { ...options, fetch: options?.fetch ?? streamFetch }) },
	});
}

const AllowedModels = Type.Object({ models: Type.Array(Type.Object({ slug: Type.String() })) });

export function withOnlyModels(provider: Provider, ids: readonly string[]): Provider {
	const allowed = new Set(ids);
	const wrapped: Provider = Object.create(provider);
	return Object.defineProperty(wrapped, "getModels", { value: () => provider.getModels().filter((model) => allowed.has(model.id)) });
}

const MODELS_KEY = "pi-mobile.chatgpt-models";

const MODEL_LIST_WAIT_MS = 5000;

export async function chatgptModelsCached(credential: OAuthCredential): Promise<string[] | undefined> {
	const ids = await orLogged(chatgptModels(credential, AbortSignal.timeout(MODEL_LIST_WAIT_MS)), "chatgpt.models_unavailable", undefined);
	if (!ids) return readStored(Type.Array(Type.String()), MODELS_KEY);
	localStorage.setItem(MODELS_KEY, JSON.stringify(ids));
	return ids;
}

export async function chatgptModels(credential: OAuthCredential, signal?: AbortSignal): Promise<string[]> {
	const response = await streamFetch(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${credential.access}` }, ...(signal ? { signal } : {}) });
	if (!response.ok) throw new Error(`ChatGPT models: HTTP ${response.status}`);
	return parse(AllowedModels, await response.json(), "ChatGPT models").models.map((model) => model.slug);
}

const StoredOAuthCredential = Type.Object({ type: Type.Literal("oauth"), access: Type.String(), refresh: Type.String(), expires: Type.Number() });

export function parseOAuthCredential(json: string): OAuthCredential | undefined {
	const value = decode(StoredOAuthCredential, json);
	return value && { ...value };
}
