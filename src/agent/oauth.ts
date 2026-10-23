// Shared OAuth plumbing for the cloud sign-ins (Google, Cloudflare, Azure): native HTTP with timeouts, token
// responses, device-flow polling, and JWT payloads. Native HTTP because the providers' endpoints do not allow the
// WebView's origin, and with timeouts because a request sent while the network drops would otherwise wait forever.
import { CapacitorHttp } from "@capacitor/core";
import { type Static, Type } from "typebox";
import { parse, parseJson } from "./parse.ts";

const TIMEOUTS = { connectTimeout: 10_000, readTimeout: 20_000 };

export interface AccessToken {
	token: string;
	/** Milliseconds since the epoch. */
	expiresAt: number;
}

export interface HttpResponse {
	status: number;
	/** The parsed JSON body, unchecked; `{}` for an empty body. */
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

/** An OAuth token endpoint's answer: tokens, or an RFC 6749 error. */
const TokenResponse = Type.Object({
	access_token: Type.Optional(Type.String()),
	refresh_token: Type.Optional(Type.String()),
	id_token: Type.Optional(Type.String()),
	expires_in: Type.Optional(Type.Union([Type.Number(), Type.String()])),
	error: Type.Optional(Type.String()),
	error_description: Type.Optional(Type.String()),
});
type TokenResponse = Static<typeof TokenResponse>;

/** A successful token response: an access token, maybe a rotated refresh token, and when it expires. */
export interface Tokens {
	access: AccessToken;
	refresh: string | undefined;
	idToken: string | undefined;
}

/** Read a token response, or throw with the provider's error description. */
export function tokensFrom(response: HttpResponse, what: string): Tokens {
	const body = parse(TokenResponse, response.body, what);
	if (response.status !== 200 || !body.access_token) {
		throw new Error(`${what}：${body.error_description ?? body.error ?? `HTTP ${response.status}`}`);
	}
	return {
		access: { token: body.access_token, expiresAt: Date.now() + Number(body.expires_in ?? 3600) * 1000 },
		refresh: body.refresh_token,
		idToken: body.id_token,
	};
}

/** The device authorization endpoint's answer (RFC 8628). */
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
	/** The page that approves the code; with the code filled in when the provider offers one. */
	url: string;
	deviceCode: string;
	intervalMs: number;
	expiresAt: number;
}

export async function startDeviceFlow({ url, form, what }: { url: string; form: Record<string, string>; what: string }): Promise<DeviceSignIn> {
	const response = await postForm({ url, form, what });
	if (response.status !== 200) {
		const error = parse(TokenResponse, response.body, what);
		throw new Error(`${what}：${error.error_description ?? error.error ?? `HTTP ${response.status}`}`);
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

/**
 * Poll the token endpoint until the user approves the device code (RFC 8628 §3.5). Network errors are retried: the
 * phone's network often drops for a moment while the user is in the browser.
 */
export async function pollDeviceFlow({
	signIn,
	url,
	form,
	what,
	signal,
}: {
	signIn: DeviceSignIn;
	url: string;
	/** Everything but the device code, which is added here. */
	form: Record<string, string>;
	what: string;
	signal: AbortSignal;
}): Promise<Tokens> {
	let interval = signIn.intervalMs;
	while (Date.now() < signIn.expiresAt) {
		await new Promise((resolve) => setTimeout(resolve, interval));
		if (signal.aborted) throw new Error("已取消");
		let response: HttpResponse;
		try {
			response = await postForm({
				url,
				form: { ...form, grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: signIn.deviceCode },
				what,
			});
		} catch {
			continue;
		}
		const body = parse(TokenResponse, response.body, what);
		if (body.error === "authorization_pending") continue;
		if (body.error === "slow_down") {
			interval += 5000;
			continue;
		}
		if (body.error === "access_denied") throw new Error(`你在${what}頁面拒絕了授權`);
		return tokensFrom(response, what);
	}
	throw new Error("登入逾時，請再試一次");
}

/** The payload of a JWT, unverified: for display and routing only, never for authorization decisions. */
export function jwtPayload(token: string): unknown {
	const part = token.split(".")[1];
	if (!part) return {};
	return parseJson(atob(part.replace(/-/g, "+").replace(/_/g, "/")), "JWT");
}

export function base64url(bytes: Uint8Array | ArrayBuffer): string {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let binary = "";
	for (const byte of view) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
