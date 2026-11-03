import { Capacitor } from "@capacitor/core";
import { Network as NetworkPlugin } from "@capacitor/network";
import type { Api, AssistantMessageEvent, AssistantMessageEventStream, Model, Provider } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { log } from "../log.ts";
import { native } from "../native.ts";
import { System } from "../plugins/system.ts";
import { orLogged } from "../promise.ts";

export interface Network {
	online(): boolean;
	onChange(listener: () => void): () => void;
}

const IDLE_MS = 60_000;
const CONNECTION_LOST = "connection lost";

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
	if (typeof window !== "undefined" && typeof document !== "undefined") {
		window.addEventListener("online", () => update(true));
		window.addEventListener("offline", () => update(false));
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "visible") changed();
		});
	}
	if (Capacitor.isPluginAvailable("Network")) {
		const read = (): Promise<boolean> =>
			native.implements(System.network) ? System.network().then((status) => status.via !== "none") : NetworkPlugin.getStatus().then((status) => status.connected);
		void orLogged(read().then(update), "network.status_failed", undefined);
		void orLogged(
			NetworkPlugin.addListener("networkStatusChange", () => void orLogged(read().then(update), "network.status_failed", undefined)),
			"network.listen_failed",
			undefined,
		);
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

export function untilOnline(network: Network, signal?: AbortSignal): Promise<void> {
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

function connected(network: Network, idleMs: number, start: Start, signal: AbortSignal | undefined): AssistantMessageEventStream {
	const guarded = createAssistantMessageEventStream();
	void (async () => {
		await untilOnline(network, signal);
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
		const inner = start(signal ? AbortSignal.any([signal, cut.signal]) : cut.signal);
		try {
			for await (const event of inner) {
				if (event.type !== "start") {
					if (idle === undefined) watchIdle(idleMs);
					heard = Date.now();
				}
				guarded.push(lost && !signal?.aborted ? asLost(event, lost) : event);
			}
		} finally {
			clearTimeout(idle);
			unwatch();
		}
		guarded.end();
	})();
	return guarded;
}

function asLost(event: AssistantMessageEvent, why: string): AssistantMessageEvent {
	if (event.type !== "error") return event;
	return { type: "error", reason: "error", error: { ...event.error, stopReason: "error", errorMessage: why } };
}

export function waitingForNetwork(provider: Provider, network: Network, idleMs = IDLE_MS): Provider {
	const wrapped: Provider = Object.create(provider);
	const streams: Streams = {
		stream: (model: Model<Api>, context, options) => connected(network, idleMs, (signal) => provider.stream(model, context, { ...options, signal }), options?.signal),
		streamSimple: (model: Model<Api>, context, options) => connected(network, idleMs, (signal) => provider.streamSimple(model, context, { ...options, signal }), options?.signal),
	};
	return Object.defineProperties(wrapped, { stream: { value: streams.stream }, streamSimple: { value: streams.streamSimple } });
}
