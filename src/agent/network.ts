import { Capacitor } from "@capacitor/core";
import { Network as NetworkPlugin } from "@capacitor/network";
import type { Api, AssistantMessageEvent, AssistantMessageEventStream, Model, Provider } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { log } from "../log.ts";
import { native } from "../native.ts";
import { System } from "../plugins/system.ts";
import { orLogged } from "../promise.ts";
import type { Reach } from "./reach.ts";
import { bytesOf, type Traffic } from "./traffic.ts";

export interface Network {
	online(): boolean;
	onChange(listener: () => void): () => void;
}

const IDLE_MS = 60_000;
const UNREACHED_TRIES = 4;
const CONNECTION_LOST = "connection lost";
const BROWSER_LOST_CONNECTION = ["Load failed", "Failed to fetch", "The network connection was lost."];
// why: the words pi-ai's providers and the browser engines give a request that never reached the server (OpenAI and Anthropic SDKs: "Connection error.", Node: "fetch failed")
const NEVER_REACHED = [...BROWSER_LOST_CONNECTION, "Connection error.", "fetch failed"];

export function isConnectionLost(error: string | undefined): boolean {
	return error?.startsWith(CONNECTION_LOST) ?? false;
}

function watchDevice(): Network {
	const listeners = new Set<() => void>();
	let connected = typeof navigator === "undefined" || navigator.onLine !== false;
	const changed = () => {
		for (const listener of listeners) listener();
	};
	const update = (now: boolean) => {
		if (now === connected) return;
		connected = now;
		log.info("network.change", { online: now });
		changed();
	};
	const read = native.implements(System.network) ? () => System.network() : () => NetworkPlugin.getStatus().then((status) => ({ online: status.connected }));
	const plugin = Capacitor.isPluginAvailable("Network");
	const refresh = (browser: boolean) => {
		if (!plugin) return update(browser);
		void orLogged(read().then((status) => update(status.online)), "network.status_failed", undefined);
	};
	if (plugin) {
		refresh(connected);
		void orLogged(NetworkPlugin.addListener("networkStatusChange", () => refresh(connected)), "network.listen_failed", undefined);
	}
	if (typeof window !== "undefined" && typeof document !== "undefined") {
		window.addEventListener("online", () => refresh(true));
		window.addEventListener("offline", () => refresh(false));
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState !== "visible") return;
			refresh(navigator.onLine);
			changed();
		});
	}
	return {
		online: () => connected,
		onChange: (listener) => {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
	};
}

let device: Network | undefined;
export const deviceNetwork: Network = {
	online: () => (device ??= watchDevice()).online(),
	onChange: (listener) => (device ??= watchDevice()).onChange(listener),
};

function untilOnline(network: Network, signal?: AbortSignal): Promise<void> {
	if (network.online() || signal?.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const done = () => {
			stop();
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const stop = network.onChange(() => {
			if (network.online()) done();
		});
		signal?.addEventListener("abort", done);
	});
}

type Streams = Pick<Provider, "stream" | "streamSimple">;
type Start = (signal: AbortSignal) => AssistantMessageEventStream;

type Links = { network: Network; reach: Reach; traffic: Traffic };

function connected({ network, reach, traffic }: Links, url: string, idleMs: number, start: Start, signal: AbortSignal | undefined): AssistantMessageEventStream {
	const guarded = createAssistantMessageEventStream();
	void (async () => {
		for (let misses = 1; ; misses++) {
			await untilOnline(network, signal);
			await reach.untilUp(signal);
			const outcome = await attempt(guarded, network, traffic, idleMs, start, signal);
			if (outcome.kind === "answered") break;
			if (misses === UNREACHED_TRIES) {
				guarded.push(outcome.event);
				break;
			}
			reach.lost(url);
		}
		guarded.end();
	})();
	return guarded;
}

async function attempt(guarded: AssistantMessageEventStream, network: Network, traffic: Traffic, idleMs: number, start: Start, signal: AbortSignal | undefined): Promise<{ kind: "answered" } | { kind: "unreached"; event: AssistantMessageEvent }> {
	const cut = new AbortController();
	let lost: string | undefined;
	const lose = (why: string) => {
		lost ??= `${CONNECTION_LOST}: ${why}`;
		cut.abort();
	};
	const unwatch = network.onChange(() => {
		if (!network.online()) lose("the network went away");
	});
	let heard = 0;
	let idle: ReturnType<typeof setTimeout> | undefined;
	const watchIdle = (wait: number) => {
		idle = setTimeout(() => {
			const quiet = Date.now() - heard;
			if (quiet >= idleMs) return lose(`no data for ${idleMs / 1000} s`);
			watchIdle(idleMs - quiet);
		}, wait);
	};
	let pushed = false;
	const inner = start(signal ? AbortSignal.any([signal, cut.signal]) : cut.signal);
	try {
		for await (const event of inner) {
			if (!pushed && !lost && !signal?.aborted && unreached(event)) return { kind: "unreached", event };
			pushed = true;
			if ("delta" in event) traffic.count("down", bytesOf(event.delta));
			if (event.type !== "start") {
				if (idle === undefined) watchIdle(idleMs);
				heard = Date.now();
			}
			guarded.push(lost && !signal?.aborted ? asLost(event, lost) : inPlainWords(event));
		}
	} finally {
		clearTimeout(idle);
		unwatch();
	}
	return { kind: "answered" };
}

function unreached(event: AssistantMessageEvent): boolean {
	return event.type === "error" && event.reason === "error" && NEVER_REACHED.includes(event.error.errorMessage ?? "");
}

function asLost(event: AssistantMessageEvent, why: string): AssistantMessageEvent {
	if (event.type !== "error") return event;
	return { type: "error", reason: "error", error: { ...event.error, stopReason: "error", errorMessage: why } };
}

function inPlainWords(event: AssistantMessageEvent): AssistantMessageEvent {
	if (event.type !== "error" || event.reason !== "error") return event;
	const words = event.error.errorMessage ?? "";
	return BROWSER_LOST_CONNECTION.includes(words) ? asLost(event, `${CONNECTION_LOST}: ${words}`) : event;
}

export function waitingForNetwork(provider: Provider, links: Links, idleMs = IDLE_MS): Provider {
	const wrapped: Provider = Object.create(provider);
	const streams: Streams = {
		stream: (model: Model<Api>, context, options) => connected(links, model.baseUrl, idleMs, (signal) => provider.stream(model, context, { ...options, signal }), options?.signal),
		streamSimple: (model: Model<Api>, context, options) => connected(links, model.baseUrl, idleMs, (signal) => provider.streamSimple(model, context, { ...options, signal }), options?.signal),
	};
	return Object.defineProperties(wrapped, { stream: { value: streams.stream }, streamSimple: { value: streams.streamSimple } });
}
