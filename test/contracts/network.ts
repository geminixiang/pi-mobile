import assert from "node:assert/strict";
import { type Api, type AssistantMessage, type AssistantMessageEventStream, fauxAssistantMessage, type Model, type Provider } from "@earendil-works/pi-ai";
import { isRetryableAssistantError, retryAssistantCall, retryDelayMs } from "@earendil-works/pi-ai/utils/retry";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { MODEL_RETRY } from "../../src/agent/retry.ts";
import { customProvider } from "../../src/agent/models.ts";
import { type Network, waitingForNetwork } from "../../src/agent/network.ts";
import { createReach, type Reach } from "../../src/agent/reach.ts";
import { createTraffic } from "../../src/agent/traffic.ts";
import { nextChange } from "./fixtures.ts";
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

function probing(network: Network, answers: () => boolean = () => true): Reach & { probes: number } {
	const counted = { probes: 0 };
	const reach = createReach("fake", async () => {
		counted.probes += 1;
		return answers();
	}, network);
	reach.onChange(() => {
		if (reach.state().kind === "down") queueMicrotask(() => reach.check());
	});
	return Object.assign(reach, counted);
}

function links(network: Network, reach: Reach = probing(network)) {
	return { network, reach, traffic: createTraffic() };
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

const failsWith =
	(errorMessage: string): Answer =>
	(events, message) => {
		queueMicrotask(() => {
			events.push({ type: "error", reason: "error", error: { ...message("error"), errorMessage } });
			events.end();
		});
	};

function answering(answers: Answer[] = [finished]) {
	const base = customProvider({ id: "fake", name: "fake", baseUrl: "https://model.invalid/v1" }, "", ["m"], new Map());
	const model = base.getModels()[0];
	assert(model);
	const calls: { aborted: boolean }[] = [];
	const message = (stopReason: AssistantMessage["stopReason"]) => fauxAssistantMessage("答案", { stopReason });
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
			const answer = ask(waitingForNetwork(provider, links(network)), model);
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
			const answer = ask(waitingForNetwork(provider, links(network)), model, stop.signal);
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
			const guarded = waitingForNetwork(provider, links(network), IDLE_MS);
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
			const answer = ask(waitingForNetwork(provider, links(network), 60_000), model);
			await sleep(20);
			network.set(false);
			const result = await within(1000, "the stream kept waiting on a network that is gone", answer);
			assert.equal(result.stopReason, "error");
			assert(isRetryableAssistantError(result), `not retried: ${result.errorMessage}`);
		},
	],
	[
		"a model the phone cannot reach is waited for, without spending a retry, and asked again once it answers",
		async () => {
			const network = switchable(true);
			let reachable = false;
			const reach = probing(network, () => reachable);
			const { provider, model, calls } = answering([failsWith("Connection error."), finished]);
			const answer = ask(waitingForNetwork(provider, links(network, reach), IDLE_MS), model);
			await sleep(50);
			assert.equal(reach.state().kind, "down", "a model it could not reach was not marked as unreachable");
			assert.equal(calls.length, 1, "the request went out again while the model was still unreachable");
			reachable = true;
			reach.check();
			const result = await within(1000, "the request never went out again after the model came back", answer);
			assert.equal(calls.length, 2);
			assert.equal(result.stopReason, "stop");
			assert.equal(reach.state().kind, "up");
		},
	],
	[
		"a server that answers the probe but never the request ends with its error after a few tries, instead of asking forever",
		async () => {
			const network = switchable(true);
			const { provider, model, calls } = answering(Array.from({ length: 10 }, () => failsWith("Connection error.")));
			const result = await within(2000, "it kept asking a model that never answers", ask(waitingForNetwork(provider, links(network), IDLE_MS), model));
			assert.equal(result.stopReason, "error");
			assert.equal(result.errorMessage, "Connection error.");
			assert.equal(calls.length, 4);
		},
	],
	[
		"stopping a request that waits for its model hands it on at once, so it ends as stopped",
		async () => {
			const network = switchable(true);
			const endsStopped: Answer = (events, message) => {
				queueMicrotask(() => {
					events.push({ type: "error", reason: "aborted", error: message("aborted") });
					events.end();
				});
			};
			const { provider, model } = answering([failsWith("Connection error."), endsStopped]);
			const stop = new AbortController();
			const answer = ask(waitingForNetwork(provider, links(network, probing(network, () => false)), IDLE_MS), model, stop.signal);
			await sleep(50);
			stop.abort();
			assert.equal((await within(1000, "a stopped request kept waiting for its model", answer)).stopReason, "aborted");
		},
	],
	[
		"a connection the browser engine reports as lost is retried, in WebKit's words and Chrome's",
		async () => {
			for (const words of ["Load failed", "Failed to fetch", "The network connection was lost."]) {
				const { provider, model, calls } = answering([failsWith(words), finished]);
				const online = switchable(true);
				const guarded = waitingForNetwork(provider, links(online), IDLE_MS);
				const result = await retryAssistantCall(() => ask(guarded, model), { ...MODEL_RETRY, baseDelayMs: 10 }, undefined);
				assert.equal(calls.length, 2, `"${words}" ended the turn instead of being retried`);
				assert.equal(result.stopReason, "stop");
			}
		},
	],
	[
		"an error that only resembles a lost connection keeps its words and is not retried",
		async () => {
			const { provider, model } = answering([failsWith("Load failed to parse the prompt")]);
			const online = switchable(true);
			const result = await ask(waitingForNetwork(provider, links(online), IDLE_MS), model);
			assert.equal(result.errorMessage, "Load failed to parse the prompt");
			assert(!isRetryableAssistantError(result));
		},
	],
	[
		"stopping an answer mid-stream stays a stop, not a network error to retry",
		async () => {
			const network = switchable(true);
			const { provider, model } = answering([stopsWhenCut]);
			const stop = new AbortController();
			const answer = ask(waitingForNetwork(provider, links(network), IDLE_MS), model, stop.signal);
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
			const result = await ask(waitingForNetwork(provider, links(network), IDLE_MS), model);
			assert.equal(calls.length, 1);
			assert.equal(result.stopReason, "stop");
		},
	],
	[
		"a model's answer counts as bytes coming down its link, in UTF-8, as it streams",
		async () => {
			const network = switchable(true);
			const streams: Answer = (events, message) => {
				const partial = message("stop");
				events.push({ type: "start", partial });
				events.push({ type: "thinking_delta", contentIndex: 0, delta: "想", partial });
				events.push({ type: "text_delta", contentIndex: 1, delta: "答案", partial });
				events.push({ type: "toolcall_delta", contentIndex: 2, delta: '{"q":1}', partial });
				finished(events, message, undefined);
			};
			const { provider, model } = answering([streams]);
			const traffic = createTraffic();
			await ask(waitingForNetwork(provider, { ...links(network), traffic }), model);
			await nextChange(traffic);
			assert.deepEqual(traffic.rates(), { up: 0, down: 3 + 6 + 7 });
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
