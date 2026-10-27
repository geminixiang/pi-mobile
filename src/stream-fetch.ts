import { native } from "./native.ts";
import { fromBase64, toBase64 } from "./encoding.ts";
import { headerRecord, NULL_BODY_STATUS } from "./http.ts";
import { StreamFetch } from "./plugins/stream-fetch.ts";
import { untilFailure } from "./promise.ts";

type Pending = {
	head: (response: Response) => void;
	fail: (error: Error) => void;
	controller?: ReadableStreamDefaultController<Uint8Array>;
	early: Uint8Array[];
	ended: boolean;
};

const pending = new Map<string, Pending>();
const listen = untilFailure(() =>
	Promise.all([
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
			request.head(new Response(NULL_BODY_STATUS.has(status) ? null : body, { status, headers }));
		}),
		StreamFetch.addListener("chunk", ({ id, data }) => {
			const request = pending.get(id);
			if (!request) return;
			if (request.controller) request.controller.enqueue(fromBase64(data));
			else request.early.push(fromBase64(data));
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
	]).then(() => undefined),
);

export async function streamFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	if (!native.has("StreamFetch")) return fetch(input, init);
	const url = input instanceof Request ? input.url : String(input);
	const method = init?.method ?? (input instanceof Request ? input.method : "GET");
	let body: { body: string } | { bodyBase64: string } | undefined;
	const fromRequest = input instanceof Request && input.body ? new Uint8Array(await input.arrayBuffer()) : undefined;
	const raw = init?.body ?? fromRequest;
	if (typeof raw === "string") body = { body: raw };
	else if (raw instanceof URLSearchParams) body = { body: raw.toString() };
	else if (raw instanceof Uint8Array) body = { bodyBase64: toBase64(raw) };
	else if (raw instanceof ArrayBuffer) body = { bodyBase64: toBase64(new Uint8Array(raw)) };
	else if (raw != null) throw new TypeError("streamFetch: unsupported body");
	init?.signal?.throwIfAborted();
	await listen();
	const { id } = await StreamFetch.start({ url, method, headers: headerRecord(input instanceof Request ? input.headers : undefined, init?.headers), ...body });
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
