import type { HttpRequest, HttpResponse } from "./protocol.ts";

export type AskHttp = (request: HttpRequest) => Promise<HttpResponse>;
export type FolderFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const NO_BODY = new Set([101, 204, 205, 304]);

async function bytesOf(body: BodyInit | null | undefined): Promise<Uint8Array | undefined> {
	if (body == null) return undefined;
	if (typeof body === "string") return new TextEncoder().encode(body);
	if (body instanceof Uint8Array) return body;
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	return new Uint8Array(await new Response(body).arrayBuffer());
}

export function folderFetch(ask: AskHttp): FolderFetch {
	return async (input, init) => {
		const request = input instanceof Request ? input : undefined;
		const headers: Record<string, string> = {};
		new Headers(request?.headers).forEach((value, key) => {
			headers[key] = value;
		});
		new Headers(init?.headers).forEach((value, key) => {
			headers[key] = value;
		});
		const body = (await bytesOf(init?.body)) ?? (request?.body ? new Uint8Array(await request.arrayBuffer()) : undefined);
		const response = await ask({
			url: request ? request.url : String(input),
			method: init?.method ?? request?.method ?? "GET",
			headers,
			...(body ? { body } : {}),
		});
		return new Response(NO_BODY.has(response.status) ? null : new Uint8Array(response.body), { status: response.status, headers: response.headers });
	};
}
