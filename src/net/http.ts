import { CapacitorHttp } from "@capacitor/core";
import { parseJson } from "../parse.ts";

export const HTTP_TIMEOUTS = { connectTimeout: 10_000, readTimeout: 20_000 };

const USER_AGENT = "pi-mobile (+https://github.com/geminixiang/pi-mobile)";

export async function getJson(url: string, what: string, signal?: AbortSignal, token?: string): Promise<unknown> {
	signal?.throwIfAborted();
	const headers = { "User-Agent": USER_AGENT, Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
	const response = await CapacitorHttp.get({ url, headers, ...HTTP_TIMEOUTS });
	if (response.status !== 200) throw new Error(`${what}: HTTP ${response.status}`);
	return typeof response.data === "string" ? parseJson(response.data, what) : response.data;
}

export const NULL_BODY_STATUS: ReadonlySet<number> = new Set([101, 204, 205, 304]);

export function headerRecord(...sources: (HeadersInit | undefined)[]): Record<string, string> {
	const merged = new Headers();
	for (const source of sources) new Headers(source).forEach((value, key) => merged.set(key, value));
	return Object.fromEntries(merged);
}
