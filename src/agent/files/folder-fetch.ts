import type { HttpRequest, HttpResponse } from "./protocol.ts";
import { headerRecord, NULL_BODY_STATUS } from "../http.ts";

type AskHttp = (request: HttpRequest) => Promise<HttpResponse>;
export type FolderFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

async function bytesOf(body: BodyInit | null | undefined): Promise<Uint8Array<ArrayBuffer> | undefined> {
	if (body == null) return undefined;
	if (typeof body === "string") return new TextEncoder().encode(body);
	if (body instanceof Uint8Array) return new Uint8Array(body);
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	return new Uint8Array(await new Response(body).arrayBuffer());
}

export function folderFetch(ask: AskHttp): FolderFetch {
	return async (input, init) => {
		const request = input instanceof Request ? input : undefined;
		const headers = headerRecord(request?.headers, init?.headers);
		const body = (await bytesOf(init?.body)) ?? (request?.body ? new Uint8Array(await request.arrayBuffer()) : undefined);
		const response = await ask({
			url: request ? request.url : String(input),
			method: init?.method ?? request?.method ?? "GET",
			headers,
			...(body ? { body } : {}),
		});
		return new Response(NULL_BODY_STATUS.has(response.status) ? null : response.body, { status: response.status, headers: response.headers });
	};
}
