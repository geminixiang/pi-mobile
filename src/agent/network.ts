import { Capacitor } from "@capacitor/core";
import { Network as NetworkPlugin } from "@capacitor/network";
import type { Api, AssistantMessageEvent, AssistantMessageEventStream, Model, Provider } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { log } from "../log.ts";
import { native } from "../native.ts";
import { System } from "../plugins/system.ts";
import { orLogged } from "../promise.ts";

export interface Network {
	current(): number | undefined;
	onChange(listener: () => void): () => void;
}

const CONNECTION_LOST = "connection lost";

export function isConnectionLost(error: string | undefined): boolean {
	return error?.startsWith(CONNECTION_LOST) ?? false;
}

interface Patience {
	quietMs: number;
	afterSwitchMs: number;
}

const PATIENCE: Patience = { quietMs: 60_000, afterSwitchMs: 5_000 };

export function isOnline(network: Network): boolean {
	return network.current() !== undefined;
}

function watchDevice(): Network {
	const listeners = new Set<() => void>();
	let next = 1;
	let current: number | undefined = typeof navigator === "undefined" || navigator.onLine !== false ? next++ : undefined;
	let via = "unknown";
	const changed = () => {
		for (const listener of listeners) listener();
	};
	const update = (connected: boolean, type: string) => {
		const was = current;
		if (!connected) current = undefined;
		else if (current === undefined || type !== via) current = next++;
		via = type;
		if (current === was) return;
		log.info("network.change", { online: connected, via: type });
		changed();
	};
	if (typeof window !== "undefined" && typeof document !== "undefined") {
		window.addEventListener("online", () => update(true, via));
		window.addEventListener("offline", () => update(false, via));
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "visible") changed();
		});
	}
	if (Capacitor.isPluginAvailable("Network")) {
		const read = (): Promise<{ connected: boolean; via: string }> =>
			native.implements(System.network)
				? System.network().then((status) => ({ connected: status.via !== "none", via: status.via }))
				: NetworkPlugin.getStatus().then((status) => ({ connected: status.connected, via: status.connectionType }));
		void orLogged(
			read().then((status) => {
				via = status.via;
				if (!status.connected) current = undefined;
			}),
			"network.status_failed",
			undefined,
		);
		void orLogged(
			NetworkPlugin.addListener("networkStatusChange", () => void orLogged(read().then((status) => update(status.connected, status.via)), "network.status_failed", undefined)),
			"network.listen_failed",
			undefined,
		);
	}
	return {
		current: () => current,
		onChange: (listener) => {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
	};
}

let device: Network | undefined;
export const deviceNetwork: Network = {
	current: () => (device ??= watchDevice()).current(),
	onChange: (listener) => (device ??= watchDevice()).onChange(listener),
};

export function untilOnline(network: Network, signal?: AbortSignal): Promise<void> {
	if (isOnline(network) || signal?.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const done = () => {
			stop();
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const stop = network.onChange(() => {
			if (isOnline(network)) done();
		});
		signal?.addEventListener("abort", done);
	});
}

type Streams = Pick<Provider, "stream" | "streamSimple">;
type Start = (signal: AbortSignal) => AssistantMessageEventStream;

function onOneNetwork(network: Network, { quietMs, afterSwitchMs }: Patience, start: Start, signal: AbortSignal | undefined): AssistantMessageEventStream {
	const guarded = createAssistantMessageEventStream();
	void (async () => {
		await untilOnline(network, signal);
		const cut = new AbortController();
		let lost: string | undefined;
		const lose = (why: string) => {
			lost ??= why;
			cut.abort();
		};
		let on = network.current();
		let deadline = Infinity;
		let quiet = `no data for ${quietMs / 1000} s`;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const check = () => {
			const left = deadline - Date.now();
			if (left <= 0) return lose(`${CONNECTION_LOST}: ${quiet}`);
			timer = setTimeout(check, left);
		};
		const expectWithin = (ms: number, why: string) => {
			deadline = Date.now() + ms;
			quiet = why;
			clearTimeout(timer);
			timer = setTimeout(check, ms);
		};
		const unwatch = network.onChange(() => {
			const now = network.current();
			if (now === on) return;
			if (now === undefined) return lose(`${CONNECTION_LOST}: the network went away`);
			on = now;
			if (deadline - Date.now() > afterSwitchMs) expectWithin(afterSwitchMs, `no data for ${afterSwitchMs / 1000} s after the network changed`);
		});
		const inner = start(signal ? AbortSignal.any([signal, cut.signal]) : cut.signal);
		try {
			for await (const event of inner) {
				if (event.type !== "start") {
					if (timer === undefined) expectWithin(quietMs, quiet);
					deadline = Date.now() + quietMs;
					quiet = `no data for ${quietMs / 1000} s`;
				}
				guarded.push(lost && !signal?.aborted ? asLost(event, lost) : event);
			}
		} finally {
			clearTimeout(timer);
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

export function waitingForNetwork(provider: Provider, network: Network, patience = PATIENCE): Provider {
	const wrapped: Provider = Object.create(provider);
	const streams: Streams = {
		stream: (model: Model<Api>, context, options) => onOneNetwork(network, patience, (signal) => provider.stream(model, context, { ...options, signal }), options?.signal),
		streamSimple: (model: Model<Api>, context, options) => onOneNetwork(network, patience, (signal) => provider.streamSimple(model, context, { ...options, signal }), options?.signal),
	};
	return Object.defineProperties(wrapped, { stream: { value: streams.stream }, streamSimple: { value: streams.streamSimple } });
}
