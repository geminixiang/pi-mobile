import { Capacitor, type PluginListenerHandle, registerPlugin } from "@capacitor/core";

interface StreamFetchPlugin {
	start(options: { url: string; method: string; headers: Record<string, string>; body?: string; bodyBase64?: string }): Promise<{ id: string }>;
	abort(options: { id: string }): Promise<void>;
	addListener(event: "head", listener: (data: { id: string; status: number; headers: Record<string, string> }) => void): Promise<PluginListenerHandle>;
	addListener(event: "chunk", listener: (data: { id: string; data: string }) => void): Promise<PluginListenerHandle>;
	addListener(event: "end", listener: (data: { id: string }) => void): Promise<PluginListenerHandle>;
	addListener(event: "error", listener: (data: { id: string; message: string }) => void): Promise<PluginListenerHandle>;
}

const StreamFetch = registerPlugin<StreamFetchPlugin>("StreamFetch");

type Pending = {
	head: (response: Response) => void;
	fail: (error: Error) => void;
	controller?: ReadableStreamDefaultController<Uint8Array>;
	early: Uint8Array[];
	ended: boolean;
};

const pending = new Map<string, Pending>();
let listening: Promise<void> | undefined;

function decode(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function encode(bytes: Uint8Array): string {
	let binary = "";
	for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
	return btoa(binary);
}

function listen(): Promise<void> {
	listening ??= Promise.all([
		StreamFetch.addListener("head", ({ id, status, headers }) => {
			const request = pending.get(id);
			if (!request) return;
			const body = new ReadableStream<Uint8Array>({
				start: (controller) => {
					request.controller = controller;
					for (const chunk of request.early) controller.enqueue(chunk);
					if (request.ended) controller.close();
				},
				cancel: () => {
					pending.delete(id);
					void StreamFetch.abort({ id });
				},
			});
			const nullBody = [101, 204, 205, 304].includes(status);
			request.head(new Response(nullBody ? null : body, { status, headers }));
		}),
		StreamFetch.addListener("chunk", ({ id, data }) => {
			const request = pending.get(id);
			if (!request) return;
			if (request.controller) request.controller.enqueue(decode(data));
			else request.early.push(decode(data));
		}),
		StreamFetch.addListener("end", ({ id }) => {
			const request = pending.get(id);
			pending.delete(id);
			if (!request) return;
			request.ended = true;
			request.controller?.close();
		}),
		StreamFetch.addListener("error", ({ id, message }) => {
			const request = pending.get(id);
			pending.delete(id);
			if (!request) return;
			const error = new TypeError(`network error: ${message}`);
			if (request.controller) request.controller.error(error);
			else request.fail(error);
		}),
	]).then(() => undefined);
	return listening;
}

function headersOf(init: RequestInit | undefined, input: RequestInfo | URL): Record<string, string> {
	const headers: Record<string, string> = {};
	const source = new Headers(input instanceof Request ? input.headers : undefined);
	new Headers(init?.headers).forEach((value, key) => source.set(key, value));
	source.forEach((value, key) => {
		headers[key] = value;
	});
	return headers;
}

export async function streamFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	if (!Capacitor.isNativePlatform()) return fetch(input, init);
	const url = input instanceof Request ? input.url : String(input);
	const method = init?.method ?? (input instanceof Request ? input.method : "GET");
	let body: { body: string } | { bodyBase64: string } | undefined;
	const fromRequest = input instanceof Request && input.body ? new Uint8Array(await input.arrayBuffer()) : undefined;
	const raw = init?.body ?? fromRequest;
	if (typeof raw === "string") body = { body: raw };
	else if (raw instanceof URLSearchParams) body = { body: raw.toString() };
	else if (raw instanceof Uint8Array) body = { bodyBase64: encode(raw) };
	else if (raw instanceof ArrayBuffer) body = { bodyBase64: encode(new Uint8Array(raw)) };
	else if (raw != null) throw new TypeError("streamFetch: unsupported body");
	if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
	await listen();
	const { id } = await StreamFetch.start({ url, method, headers: headersOf(init, input), ...body });
	return new Promise<Response>((resolve, reject) => {
		pending.set(id, { head: resolve, fail: reject, early: [], ended: false });
		init?.signal?.addEventListener(
			"abort",
			() => {
				void StreamFetch.abort({ id });
				const request = pending.get(id);
				pending.delete(id);
				const error = new DOMException("Aborted", "AbortError");
				if (request?.controller) request.controller.error(error);
				else reject(error);
			},
			{ once: true },
		);
	});
}
