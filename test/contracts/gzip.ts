import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { contentText } from "@earendil-works/pi-ai";
import { loadModels } from "../../src/agent/available-models.ts";
import type { Settings } from "../../src/settings.ts";
import { type Check, platform, settings } from "./setup.ts";

const MODEL = "claude-fixture";
const ASKED = "台積電今天收多少";
const MODEL_FIELD = /"model":"([^"]+)"/;

const ANSWER = [
	{ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
	{ type: "message_stop" },
]
	.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
	.join("");

type Received = { model: string | undefined; gzip: boolean; text: string };

function gateway(readsGzip: boolean) {
	const received: Received[] = [];
	const send: typeof fetch = async (_input, init) => {
		const raw = init?.body;
		const bytes = typeof raw === "string" ? Buffer.from(raw) : raw instanceof Uint8Array ? Buffer.from(raw) : Buffer.alloc(0);
		const gzip = new Headers(init?.headers).get("content-encoding") === "gzip";
		const text = readsGzip && gzip ? gunzipSync(bytes).toString() : bytes.toString();
		const model = MODEL_FIELD.exec(text)?.[1];
		received.push({ model, gzip, text });
		if (model === undefined) return Response.json({ error: { message: "invalid JSON body" } }, { status: 400 });
		if (model !== MODEL) return Response.json({ error: { message: `unknown provider for model ${model}` } }, { status: 400 });
		return new Response(ANSWER, { headers: { "content-type": "text/event-stream" } });
	};
	return { received, send };
}

async function ask(baseUrl: string, send: typeof fetch): Promise<string> {
	const configured: Settings = { ...settings, providers: [{ kind: "custom", id: "gateway", name: "gateway", baseUrl }], providerKeys: {}, providerOAuth: {} };
	const { models } = await loadModels(configured, () => configured.compactAt, Promise.resolve({ gateway: [MODEL] }), platform.settings);
	const model = models.getModel("gateway", MODEL);
	assert(model);
	const reply = await models.completeSimple(model, { messages: [{ role: "user", content: ASKED, timestamp: Date.now() }] }, { fetch: send });
	assert.equal(reply.stopReason, "stop", reply.errorMessage ?? "");
	return contentText(reply.content);
}

export const checks: Check[] = [
	[
		"a custom endpoint that reads gzip gets every model request compressed, after checking it once",
		async () => {
			const { received, send } = gateway(true);
			for (let turn = 0; turn < 2; turn++) assert.equal(await ask("http://reads-gzip.test:8317", send), "ok");
			const requests = received.filter((request) => request.model === MODEL);
			assert.equal(requests.length, 2);
			assert(requests.every((request) => request.gzip && request.text.includes(ASKED)));
			assert.deepEqual(
				received
					.filter((request) => request.model !== MODEL)
					.map((probe) => probe.gzip)
					.sort(),
				[false, true],
			);
		},
	],
	[
		"a custom endpoint that cannot read gzip still gets every model request, uncompressed",
		async () => {
			const { received, send } = gateway(false);
			for (let turn = 0; turn < 2; turn++) assert.equal(await ask("http://plain-only.test:8317", send), "ok");
			const requests = received.filter((request) => request.model === MODEL);
			assert.equal(requests.length, 2);
			assert(requests.every((request) => !request.gzip && request.text.includes(ASKED)));
			assert.equal(received.filter((request) => request.gzip).length, 1);
		},
	],
];
