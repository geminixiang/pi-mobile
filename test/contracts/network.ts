import assert from "node:assert/strict";
import type { Api, AssistantMessage, Model, Provider } from "@earendil-works/pi-ai";
import { retryDelayMs } from "@earendil-works/pi-ai/utils/retry";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { MODEL_RETRY } from "../../src/agent/retry.ts";
import { customProvider } from "../../src/agent/models.ts";
import { type Network, waitingForNetwork } from "../../src/agent/network.ts";
import { sleep } from "../../src/promise.ts";
import type { Check } from "./setup.ts";

const SLOWEST_RETRY_MS = 30_000;

function switchable(): Network & { set(online: boolean): void } {
	const listeners = new Set<() => void>();
	let online = false;
	return {
		online: () => online,
		onChange: (listener) => {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		set(next) {
			online = next;
			for (const listener of listeners) listener();
		},
	};
}

function answering() {
	const base = customProvider({ id: "fake", name: "fake", baseUrl: "https://model.invalid/v1" }, "", ["m"], new Map());
	const model = base.getModels()[0];
	assert(model);
	const calls: { aborted: boolean }[] = [];
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "答案" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 0,
	};
	const stream = (_model: Model<Api>, _context: unknown, options?: { signal?: AbortSignal }) => {
		calls.push({ aborted: options?.signal?.aborted ?? false });
		const events = createAssistantMessageEventStream();
		queueMicrotask(() => {
			events.push({ type: "done", reason: "stop", message });
			events.end(message);
		});
		return events;
	};
	const provider: Provider = Object.defineProperties(Object.create(base), { stream: { value: stream }, streamSimple: { value: stream } });
	return { provider, model, calls };
}

export const checks: Check[] = [
	[
		"a model request made without a network waits for it, then goes out once the network is back",
		async () => {
			const network = switchable();
			const { provider, model, calls } = answering();
			const answer = waitingForNetwork(provider, network).streamSimple(model, normalizeContext({ messages: [] }), {});
			await sleep(300);
			assert.equal(calls.length, 0, "the request went out with no network, and would fail and spend a retry");
			network.set(true);
			const result = await answer.result();
			assert.equal(calls.length, 1);
			assert.equal(result.stopReason, "stop");
			assert.deepEqual(result.content, [{ type: "text", text: "答案" }]);
		},
	],
	[
		"stopping a request that waits for the network hands it on at once, so it ends as stopped",
		async () => {
			const network = switchable();
			const { provider, model, calls } = answering();
			const stop = new AbortController();
			const answer = waitingForNetwork(provider, network).streamSimple(model, normalizeContext({ messages: [] }), { signal: stop.signal });
			stop.abort();
			await answer.result();
			assert.deepEqual(calls, [{ aborted: true }]);
		},
	],
	[
		"a retry while online never waits so long that a working network sits idle",
		async () => {
			const waits = Array.from({ length: MODEL_RETRY.maxRetries }, (_, index) => retryDelayMs(MODEL_RETRY, index + 1));
			assert(Math.max(...waits) <= SLOWEST_RETRY_MS, `the longest wait is ${Math.max(...waits) / 1000} s`);
		},
	],
];
