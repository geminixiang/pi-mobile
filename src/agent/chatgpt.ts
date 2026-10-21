// Sign in with ChatGPT: the OpenAI provider used with the user's ChatGPT subscription instead of an API key, OpenAI's
// own flow for agents. pi-ai implements it for Node (a callback server on 127.0.0.1:1455, node:crypto), which the
// WebView has neither of; this is the same flow with the loopback redirect served by LoopbackPlugin.java, PKCE from
// WebCrypto, and token requests over native HTTP. It replaces the OpenAI provider's auth.oauth, so pi-ai still owns
// refreshing (under its credential-store lock) and request auth.
//
// The flow, as pi-ai's auth/oauth/openai-chatgpt.ts: authorize with the client "dynamic_agent_client", an agent name
// and a stable host id for this installation; the callback brings the code and the client id OpenAI issued; the code
// is exchanged with PKCE; the grant must include the direct-token scope; the access token is then the API key.
import { type PluginListenerHandle, registerPlugin } from "@capacitor/core";
import type { Api, ApiStreamOptions, Model, OAuthAuth, OAuthCredential, Provider, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { streamFetch } from "../stream-fetch.ts";
import { Type } from "typebox";
import { base64url, postForm } from "./oauth.ts";
import { parse } from "./parse.ts";

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
/** Refresh this long before expiry, so a request never starts with a token about to lapse. */
const EXPIRY_MARGIN_MS = 3 * 60_000;
const WAIT_MS = 10 * 60_000;
const DEVICE_KEY = "pi-mobile.device-id";

interface LoopbackPlugin {
	start(options: { port: number; path: string }): Promise<{ port: number }>;
	stop(): Promise<void>;
	addListener(event: "redirect", listener: (data: { url: string }) => void): Promise<PluginListenerHandle>;
}
const Loopback = registerPlugin<LoopbackPlugin>("Loopback");

const TokenResponse = Type.Object({
	access_token: Type.String({ minLength: 1 }),
	refresh_token: Type.String({ minLength: 1 }),
	scope: Type.String(),
	expires_in: Type.Number({ exclusiveMinimum: 0 }),
	id_token: Type.Optional(Type.String()),
});

/** This installation's stable id, which OpenAI knows the agent host by. */
function deviceId(): string {
	let id = localStorage.getItem(DEVICE_KEY);
	if (!id) {
		id = crypto.randomUUID();
		localStorage.setItem(DEVICE_KEY, id);
	}
	return id;
}

const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

async function pkce(): Promise<{ verifier: string; challenge: string }> {
	const verifier = random();
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: base64url(digest) };
}

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

/**
 * Sign in in the browser and return the credential, or throw. `openUrl` opens the authorization page; the browser
 * comes back to the loopback address, whose page returns to pi.
 */
export async function signInWithChatGPT(openUrl: (url: string) => Promise<void>): Promise<OAuthCredential> {
	const { verifier, challenge } = await pkce();
	const state = random();
	await Loopback.start({ port: PORT, path: PATH });
	let listener: PluginListenerHandle | undefined;
	const callback = new Promise<URL>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("沒有完成登入")), WAIT_MS);
		void Loopback.addListener("redirect", ({ url }) => {
			clearTimeout(timer);
			resolve(new URL(url));
		}).then((handle) => {
			listener = handle;
		});
	});
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
		void listener?.remove();
		void Loopback.stop();
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

/**
 * The OpenAI provider with this sign-in as its OAuth, and its requests over native HTTP (stream-fetch.ts): answers to
 * a ChatGPT token carry no CORS headers, so the WebView may not read them. Everything else stays pi-ai's.
 */
export function withChatGPTSignIn(provider: Provider): Provider {
	const wrapped: Provider = Object.create(provider);
	return Object.defineProperties(wrapped, {
		auth: { value: { ...provider.auth, oauth: chatgptOAuth }, enumerable: true },
		stream: { value: (model: Model<Api>, context: TranscriptContext, options?: ApiStreamOptions<Api>) => provider.stream(model, context, { ...options, fetch: options?.fetch ?? streamFetch }) },
		streamSimple: { value: (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => provider.streamSimple(model, context, { ...options, fetch: options?.fetch ?? streamFetch }) },
	});
}

const AllowedModels = Type.Object({ models: Type.Array(Type.Object({ slug: Type.String() })) });

/** The provider offering only these models of its catalog. */
export function withOnlyModels(provider: Provider, ids: readonly string[]): Provider {
	const wrapped: Provider = Object.create(provider);
	return Object.defineProperty(wrapped, "getModels", { value: () => provider.getModels().filter((model) => ids.includes(model.id)) });
}

const MODELS_KEY = "pi-mobile.chatgpt-models";

/** The subscription's models: fresh when OpenAI answers within a few seconds, else those from the last time. */
export async function chatgptModelsCached(credential: OAuthCredential): Promise<string[] | undefined> {
	try {
		const ids = await Promise.race([chatgptModels(credential), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000))]);
		localStorage.setItem(MODELS_KEY, JSON.stringify(ids));
		return ids;
	} catch {
		try {
			const value: unknown = JSON.parse(localStorage.getItem(MODELS_KEY) ?? "null");
			return Array.isArray(value) && value.every((id) => typeof id === "string") ? value : undefined;
		} catch {
			return undefined;
		}
	}
}

/**
 * The models a ChatGPT subscription may use, from OpenAI's /v1/models with its token (a list of slugs, unlike the
 * API's). Others answer "not supported when using Codex with a ChatGPT account".
 */
export async function chatgptModels(credential: OAuthCredential): Promise<string[]> {
	const response = await streamFetch(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${credential.access}` } });
	if (!response.ok) throw new Error(`ChatGPT models: HTTP ${response.status}`);
	return parse(AllowedModels, await response.json(), "ChatGPT models").models.map((model) => model.slug);
}

/** A stored sign-in, from its JSON in the Keystore; undefined when it is not one. */
export function parseOAuthCredential(json: string): OAuthCredential | undefined {
	try {
		const value: unknown = JSON.parse(json);
		if (typeof value !== "object" || value === null) return undefined;
		const { access, refresh, expires } = { access: Reflect.get(value, "access"), refresh: Reflect.get(value, "refresh"), expires: Reflect.get(value, "expires") };
		if (Reflect.get(value, "type") !== "oauth" || typeof access !== "string" || typeof refresh !== "string" || typeof expires !== "number") return undefined;
		return { ...Object.fromEntries(Object.entries(value)), type: "oauth", access, refresh, expires };
	} catch {
		return undefined;
	}
}
