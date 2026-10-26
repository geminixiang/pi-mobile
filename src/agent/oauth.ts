import { CapacitorHttp } from "@capacitor/core";
import { type Static, Type } from "typebox";
import { check, type Checked, parse, parseJson, valueOrThrow } from "./parse.ts";
import { orLogged, sleep } from "../promise.ts";
import { toBase64Url } from "../encoding.ts";

const TIMEOUTS = { connectTimeout: 10_000, readTimeout: 20_000 };

export interface AccessToken {
	token: string;
	expiresAt: number;
}

export interface HttpResponse {
	status: number;
	body: unknown;
}

function bodyOf(data: unknown, what: string): unknown {
	if (typeof data !== "string") return data ?? {};
	return data ? parseJson(data, what) : {};
}

export async function postForm({ url, form, what }: { url: string; form: Record<string, string>; what: string }): Promise<HttpResponse> {
	const response = await CapacitorHttp.post({
		url,
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		data: new URLSearchParams(form).toString(),
		...TIMEOUTS,
	});
	return { status: response.status, body: bodyOf(response.data, what) };
}

export async function getJson({ url, token, what }: { url: string; token: string; what: string }): Promise<HttpResponse> {
	const response = await CapacitorHttp.get({ url, headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, ...TIMEOUTS });
	return { status: response.status, body: bodyOf(response.data, what) };
}

const TokenResponse = Type.Object({
	access_token: Type.Optional(Type.String()),
	refresh_token: Type.Optional(Type.String()),
	id_token: Type.Optional(Type.String()),
	expires_in: Type.Optional(Type.Union([Type.Number(), Type.String()])),
	error: Type.Optional(Type.String()),
	error_description: Type.Optional(Type.String()),
});
type TokenResponse = Static<typeof TokenResponse>;

interface Tokens {
	access: AccessToken;
	refresh: string | undefined;
	idToken: string | undefined;
}

export function checkTokens(response: HttpResponse, what: string): Checked<Tokens> {
	const checked = check(TokenResponse, response.body, what);
	if (!checked.ok) return checked;
	const body = checked.value;
	if (response.status !== 200 || !body.access_token) return { ok: false, problem: oauthProblem(body, response.status, what) };
	return {
		ok: true,
		value: {
			access: { token: body.access_token, expiresAt: Date.now() + Number(body.expires_in ?? 3600) * 1000 },
			refresh: body.refresh_token,
			idToken: body.id_token,
		},
	};
}

function oauthProblem(body: TokenResponse, status: number, what: string): string {
	return `${what}：${body.error_description ?? body.error ?? `HTTP ${status}`}`;
}

export function refreshedTokens(response: HttpResponse, what: string): Tokens {
	const checked = checkTokens(response, what);
	if (!checked.ok) throw new Error(`${checked.problem}（可能需要在設定重新登入）`);
	return checked.value;
}

export function cachedToken<A extends unknown[]>(mint: (...args: A) => Promise<AccessToken>): (...args: A) => Promise<AccessToken> {
	let cached: AccessToken | undefined;
	let pending: Promise<AccessToken> | undefined;
	return (...args) => {
		if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return Promise.resolve(cached);
		pending ??= mint(...args)
			.then((token) => {
				cached = token;
				return token;
			})
			.finally(() => {
				pending = undefined;
			});
		return pending;
	};
}

const DeviceAuthorization = Type.Object({
	device_code: Type.String(),
	user_code: Type.String(),
	verification_uri: Type.String(),
	verification_uri_complete: Type.Optional(Type.String()),
	expires_in: Type.Optional(Type.Number()),
	interval: Type.Optional(Type.Number()),
});

export interface DeviceSignIn {
	userCode: string;
	url: string;
	deviceCode: string;
	intervalMs: number;
	expiresAt: number;
}

export async function startDeviceFlow({ url, form, what }: { url: string; form: Record<string, string>; what: string }): Promise<DeviceSignIn> {
	const response = await postForm({ url, form, what });
	if (response.status !== 200) {
		throw new Error(oauthProblem(parse(TokenResponse, response.body, what), response.status, what));
	}
	const body = parse(DeviceAuthorization, response.body, what);
	return {
		userCode: body.user_code,
		url: body.verification_uri_complete ?? body.verification_uri,
		deviceCode: body.device_code,
		intervalMs: (body.interval ?? 5) * 1000,
		expiresAt: Date.now() + (body.expires_in ?? 300) * 1000,
	};
}

export async function pollDeviceFlow({
	signIn,
	url,
	form,
	what,
	signal,
}: {
	signIn: DeviceSignIn;
	url: string;
	form: Record<string, string>;
	what: string;
	signal: AbortSignal;
}): Promise<Tokens> {
	let interval = signIn.intervalMs;
	while (Date.now() < signIn.expiresAt) {
		await sleep(interval);
		if (signal.aborted) throw new Error("已取消");
		const response = await orLogged(
			postForm({ url, form: { ...form, grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: signIn.deviceCode }, what }),
			"oauth.poll_unreachable",
			undefined,
			{ what },
		);
		const isTransientNetworkFailure = response === undefined;
		if (isTransientNetworkFailure) continue;
		const body = parse(TokenResponse, response.body, what);
		if (body.error === "authorization_pending") continue;
		if (body.error === "slow_down") {
			interval += 5000;
			continue;
		}
		if (body.error === "access_denied") throw new Error(`你在${what}頁面拒絕了授權`);
		return valueOrThrow(checkTokens(response, what));
	}
	throw new Error("登入逾時，請再試一次");
}

export async function pkce(bytes: number): Promise<{ verifier: string; challenge: string }> {
	const verifier = toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
	return { verifier, challenge: toBase64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))) };
}

export function jwtPayload(token: string): unknown {
	const part = token.split(".")[1];
	if (!part) return {};
	return parseJson(atob(part.replace(/-/g, "+").replace(/_/g, "/")), "JWT");
}
