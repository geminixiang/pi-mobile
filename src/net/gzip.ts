import type { Api, ApiStreamOptions, Model, Provider, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { deadline } from "pi-mobile-base/time";
import { randomHex } from "../encoding.ts";

type Send = typeof fetch;
type Verdict = "gzip" | "plain" | "unknown";

const PROBE_TIMEOUT_MS = 10_000;
const verdicts = new Map<string, Promise<Verdict>>();

export function gzipRequests(provider: Provider): Provider {
	const wrapped: Provider = Object.create(provider);
	const send = (options?: { fetch?: Send }) => gzipping(options?.fetch ?? ((input, init) => fetch(input, init)));
	return Object.defineProperties(wrapped, {
		stream: { value: (model: Model<Api>, context: TranscriptContext, options?: ApiStreamOptions<Api>) => provider.stream(model, context, { ...options, fetch: send(options) }) },
		streamSimple: { value: (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => provider.streamSimple(model, context, { ...options, fetch: send(options) }) },
	});
}

function gzipping(send: Send): Send {
	return async (input, init) => {
		const body = init?.body;
		if (init?.method !== "POST" || typeof body !== "string" || input instanceof Request) return send(input, init);
		const url = String(input);
		if ((await verdictFor(send, url, init.headers)) !== "gzip") return send(input, init);
		const headers = new Headers(init.headers);
		headers.set("content-encoding", "gzip");
		headers.delete("content-length");
		return send(input, { ...init, headers, body: await gzip(body) });
	};
}

function verdictFor(send: Send, url: string, headers: HeadersInit | undefined): Promise<Verdict> {
	const known = verdicts.get(url);
	if (known) return known;
	const asked = probe(send, url, headers);
	verdicts.set(url, asked);
	void asked.then((verdict) => {
		if (verdict === "unknown") verdicts.delete(url);
	});
	return asked;
}

async function probe(send: Send, url: string, headers: HeadersInit | undefined): Promise<Verdict> {
	const model = `pi-gzip-probe-${randomHex(4)}`;
	const body = JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "." }] });
	const ask = async (encoded: boolean) => {
		const sent = new Headers(headers);
		sent.delete("content-length");
		if (encoded) sent.set("content-encoding", "gzip");
		const response = await send(url, { method: "POST", headers: sent, body: encoded ? await gzip(body) : body, signal: deadline(PROBE_TIMEOUT_MS) });
		return { status: response.status, read: (await response.text()).includes(model) };
	};
	const [plain, encoded] = await Promise.allSettled([ask(false), ask(true)]);
	if (plain.status === "rejected") return "unknown";
	if (encoded.status === "rejected") return "plain";
	return plain.value.read && encoded.value.read && plain.value.status === encoded.value.status ? "gzip" : "plain";
}

async function gzip(text: string): Promise<Uint8Array<ArrayBuffer>> {
	const compressed = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
	return new Uint8Array(await new Response(compressed).arrayBuffer());
}
