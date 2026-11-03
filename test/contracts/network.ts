import assert from "node:assert/strict";
import type { Api, AssistantMessage, AssistantMessageEventStream, Model, Provider } from "@earendil-works/pi-ai";
import { isRetryableAssistantError, retryAssistantCall, retryDelayMs } from "@earendil-works/pi-ai/utils/retry";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { MODEL_RETRY } from "../../src/agent/retry.ts";
import { customProvider } from "../../src/agent/models.ts";
import { type Network, waitingForNetwork } from "../../src/agent/network.ts";
import { sleep } from "../../src/promise.ts";
import type { Check } from "./setup.ts";

const SLOWEST_RETRY_MS = 30_000;
const IDLE_MS = 300;

function switchable(online = false): Network & { set(online: boolean): void } {
	const listeners = new Set<() => void>();
	let current = online;
	return {
		online: () => current,
		onChange: (listener) => {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		set(next) {
			current = next;
			for (const listener of listeners) listener();
		},
	};
}

type Answer = (events: AssistantMessageEventStream, message: (stopReason: AssistantMessage["stopReason"]) => AssistantMessage, signal: AbortSignal | undefined) => void;

const finished: Answer = (events, message) => {
	queueMicrotask(() => {
		events.push({ type: "done", reason: "stop", message: message("stop") });
		events.end();
	});
};

const stopsWhenCut: Answer = (events, message, signal) => {
	events.push({ type: "start", partial: message("stop") });
	events.push({ type: "text_start", contentIndex: 0, partial: message("stop") });
	events.push({ type: "text_delta", contentIndex: 0, delta: "答", partial: message("stop") });
	signal?.addEventListener("abort", () => {
		events.push({ type: "error", reason: "aborted", error: message("aborted") });
		events.end();
	});
};

function answering(answers: Answer[] = [finished]) {
	const base = customProvider({ id: "fake", name: "fake", baseUrl: "https://model.invalid/v1" }, "", ["m"], new Map());
	const model = base.getModels()[0];
	assert(model);
	const calls: { aborted: boolean }[] = [];
	const message = (stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
		role: "assistant",
		content: [{ type: "text", text: "答案" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		timestamp: 0,
	});
	const stream = (_model: Model<Api>, _context: unknown, options?: { signal?: AbortSignal }) => {
		calls.push({ aborted: options?.signal?.aborted ?? false });
		const events = createAssistantMessageEventStream();
		const answer = answers[calls.length - 1] ?? finished;
		answer(events, message, options?.signal);
		return events;
	};
	const provider: Provider = Object.defineProperties(Object.create(base), { stream: { value: stream }, streamSimple: { value: stream } });
	return { provider, model, calls };
}

function ask(provider: Provider, model: Model<Api>, signal?: AbortSignal) {
	return provider.streamSimple(model, normalizeContext({ messages: [] }), { signal }).result();
}

function within<T>(ms: number, what: string, work: Promise<T>): Promise<T> {
	return Promise.race([work, sleep(ms).then(() => assert.fail(what))]);
}

export const checks: Check[] = [
	[
		"a model request made without a network waits for it, then goes out once the network is back",
		async () => {
			const network = switchable();
			const { provider, model, calls } = answering();
			const answer = ask(waitingForNetwork(provider, network), model);
			await sleep(300);
			assert.equal(calls.length, 0, "the request went out with no network, and would fail and spend a retry");
			network.set(true);
			const result = await answer;
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
			const answer = ask(waitingForNetwork(provider, network), model, stop.signal);
			stop.abort();
			await answer;
			assert.deepEqual(calls, [{ aborted: true }]);
		},
	],
	[
		"an answer that goes silent mid-stream is cut and retried, instead of hanging on a connection the network dropped",
		async () => {
			const network = switchable(true);
			const { provider, model, calls } = answering([stopsWhenCut, finished]);
			const guarded = waitingForNetwork(provider, network, IDLE_MS);
			const result = await within(5000, "a silent stream was never cut, so the answer hangs forever", retryAssistantCall(() => ask(guarded, model), { ...MODEL_RETRY, baseDelayMs: 10 }, undefined));
			assert.equal(calls.length, 2);
			assert.equal(result.stopReason, "stop");
		},
	],
	[
		"an answer streaming when the network goes away is cut at once as a retryable error",
		async () => {
			const network = switchable(true);
			const { provider, model } = answering([stopsWhenCut]);
			const answer = ask(waitingForNetwork(provider, network, 60_000), model);
			await sleep(20);
			network.set(false);
			const result = await within(1000, "the stream kept waiting on a network that is gone", answer);
			assert.equal(result.stopReason, "error");
			assert(isRetryableAssistantError(result), `not retried: ${result.errorMessage}`);
		},
	],
	[
		"stopping an answer mid-stream stays a stop, not a network error to retry",
		async () => {
			const network = switchable(true);
			const { provider, model } = answering([stopsWhenCut]);
			const stop = new AbortController();
			const answer = ask(waitingForNetwork(provider, network, IDLE_MS), model, stop.signal);
			await sleep(20);
			stop.abort();
			network.set(false);
			assert.equal((await answer).stopReason, "aborted");
		},
	],
	[
		"a model thinking before its first word is not cut for being quiet",
		async () => {
			const network = switchable(true);
			const thinking: Answer = (events, message) => {
				events.push({ type: "start", partial: message("stop") });
				void sleep(IDLE_MS * 3).then(() => finished(events, message, undefined));
			};
			const { provider, model, calls } = answering([thinking]);
			const result = await ask(waitingForNetwork(provider, network, IDLE_MS), model);
			assert.equal(calls.length, 1);
			assert.equal(result.stopReason, "stop");
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
