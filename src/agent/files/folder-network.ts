import { streamFetch } from "../../stream-fetch.ts";
import type { HttpRequest, HttpResponse } from "./protocol.ts";

export interface FolderNetwork {
	githubToken?: string;
}

const GITHUB_HOSTS = new Set(["github.com", "api.github.com", "uploads.github.com", "codeload.github.com"]);
const GIT_HOST = "github.com";

export function reachable(url: string): URL | undefined {
	if (!URL.canParse(url)) return undefined;
	const parsed = new URL(url);
	if (parsed.protocol !== "https:") return undefined;
	return GITHUB_HOSTS.has(parsed.hostname) || parsed.hostname.endsWith(".githubusercontent.com") ? parsed : undefined;
}

function withCredentials(url: URL, headers: Record<string, string>, token: string | undefined): Record<string, string> {
	const supplied = Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
	if (!token || supplied || url.hostname.endsWith(".githubusercontent.com")) return headers;
	const authorization = url.hostname === GIT_HOST ? `Basic ${btoa(`x-access-token:${token}`)}` : `Bearer ${token}`;
	return { ...headers, Authorization: authorization };
}

export async function sendFromFolder(request: HttpRequest, network: FolderNetwork): Promise<HttpResponse> {
	const url = reachable(request.url);
	if (!url) throw new Error(`network: the phone folder reaches only GitHub over https, not ${request.url}`);
	const response = await streamFetch(url.href, {
		method: request.method,
		headers: withCredentials(url, request.headers, network.githubToken),
		...(request.body && request.body.length > 0 ? { body: new Uint8Array(request.body) } : {}),
	});
	const headers: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		headers[key] = value;
	});
	return { status: response.status, headers, body: new Uint8Array(await response.arrayBuffer()) };
}
