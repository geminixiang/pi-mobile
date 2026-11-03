import { Capacitor } from "@capacitor/core";
import { Network as NetworkPlugin } from "@capacitor/network";
import type { Api, AssistantMessageEventStream, Model, Provider } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { orLogged } from "../promise.ts";

export interface Network {
	online(): boolean;
	onChange(listener: () => void): () => void;
}

function watchDevice(): Network {
	const listeners = new Set<() => void>();
	let connected = typeof navigator === "undefined" || navigator.onLine !== false;
	const changed = () => {
		for (const listener of listeners) listener();
	};
	if (typeof window !== "undefined" && typeof document !== "undefined") {
		window.addEventListener("online", () => {
			connected = true;
			changed();
		});
		window.addEventListener("offline", () => {
			connected = false;
			changed();
		});
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "visible") changed();
		});
	}
	if (Capacitor.isPluginAvailable("Network")) {
		void orLogged(
			NetworkPlugin.getStatus().then((status) => {
				connected = status.connected;
			}),
			"network.status_failed",
			undefined,
		);
		void orLogged(
			NetworkPlugin.addListener("networkStatusChange", (status) => {
				connected = status.connected;
				changed();
			}),
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

function afterNetwork<O extends { signal?: AbortSignal }>(network: Network, start: () => AssistantMessageEventStream, options: O | undefined): AssistantMessageEventStream {
	if (network.online()) return start();
	const waiting = createAssistantMessageEventStream();
	void untilOnline(network, options?.signal).then(async () => {
		const inner = start();
		for await (const event of inner) waiting.push(event);
		waiting.end(await inner.result());
	});
	return waiting;
}

export function waitingForNetwork(provider: Provider, network: Network): Provider {
	const wrapped: Provider = Object.create(provider);
	const streams: Streams = {
		stream: (model: Model<Api>, context, options) => afterNetwork(network, () => provider.stream(model, context, options), options),
		streamSimple: (model: Model<Api>, context, options) => afterNetwork(network, () => provider.streamSimple(model, context, options), options),
	};
	return Object.defineProperties(wrapped, { stream: { value: streams.stream }, streamSimple: { value: streams.streamSimple } });
}
