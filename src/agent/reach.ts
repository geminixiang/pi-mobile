import { log } from "../log.ts";
import { deviceNetwork, type Network } from "./network.ts";
import { messageOf } from "../promise.ts";
import { streamFetch } from "./stream-fetch.ts";

export type ReachState = { kind: "up"; back?: { since: number; at: number } } | { kind: "down"; since: number };

export interface Reach {
	state(): ReachState;
	onChange(listener: () => void): () => void;
	lost(url: string): void;
	check(): void;
	untilUp(signal?: AbortSignal): Promise<void>;
}

type Probe = (url: string) => Promise<boolean>;

const FIRST_WAIT_MS = 2_000;
const LONGEST_WAIT_MS = 15_000;
const PROBE_TIMEOUT_MS = 5_000;

export function createReach(name: string, probe: Probe, network: Network, now: () => number = Date.now): Reach {
	const listeners = new Set<() => void>();
	let state: ReachState = { kind: "up" };
	let url = "";
	let tries = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let probing = false;
	const set = (next: ReachState) => {
		state = next;
		log.info("model.reach", { provider: name, up: String(next.kind === "up") });
		for (const listener of listeners) listener();
	};
	const downSince = () => (state.kind === "down" ? state.since : undefined);
	const run = async () => {
		clearTimeout(timer);
		timer = undefined;
		if (downSince() === undefined || probing) return;
		probing = true;
		const reached = network.online() && (await probe(url));
		probing = false;
		const since = downSince();
		if (since === undefined) return;
		if (reached) return set({ kind: "up", back: { since, at: now() } });
		tries += 1;
		timer = setTimeout(() => void run(), Math.min(FIRST_WAIT_MS * 2 ** (tries - 1), LONGEST_WAIT_MS));
	};
	network.onChange(() => void run());
	const onChange = (listener: () => void) => {
		listeners.add(listener);
		return () => void listeners.delete(listener);
	};
	return {
		state: () => state,
		onChange,
		lost: (where) => {
			url = where;
			if (state.kind === "down") return;
			tries = 0;
			set({ kind: "down", since: now() });
			timer = setTimeout(() => void run(), FIRST_WAIT_MS);
		},
		check: () => void run(),
		untilUp: (signal) => {
			if (state.kind === "up" || signal?.aborted) return Promise.resolve();
			return new Promise((resolve) => {
				const done = () => {
					stop();
					signal?.removeEventListener("abort", done);
					resolve();
				};
				const stop = onChange(() => {
					if (state.kind === "up") done();
				});
				signal?.addEventListener("abort", done);
			});
		},
	};
}

const answers: Probe = async (url) => {
	const failure = await streamFetch(url, { method: "HEAD", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }).then(
		() => undefined,
		(error: unknown) => messageOf(error),
	);
	if (failure !== undefined) log.info("model.probe_failed", { url, error: failure });
	return failure === undefined;
};

const reaches = new Map<string, Reach>();

export function modelReach(provider: string): Reach {
	const known = reaches.get(provider);
	if (known) return known;
	const created = createReach(provider, answers, deviceNetwork);
	reaches.set(provider, created);
	return created;
}
