import { log } from "./log.ts";

export function settled(promise: Promise<unknown>): Promise<void> {
	return promise.then(
		() => undefined,
		() => undefined,
	);
}

export function serially(): <T>(run: () => Promise<T>) => Promise<T> {
	let tail: Promise<void> = Promise.resolve();
	return (run) => {
		const turn = tail.then(run);
		tail = settled(turn);
		return turn;
	};
}

export function sharedUntilFailure<K, V>(cache: Map<K, Promise<V>>, key: K, start: () => Promise<V>): Promise<V> {
	const cached = cache.get(key);
	if (cached) return cached;
	const started = start();
	cache.set(key, started);
	onFailure(started, () => cache.delete(key));
	return started;
}

export function untilFailure<T>(start: () => Promise<T>): () => Promise<T> {
	let current: Promise<T> | undefined;
	return () => {
		if (current) return current;
		const started = start();
		current = started;
		onFailure(started, () => {
			current = undefined;
		});
		return started;
	};
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function onFailure(promise: Promise<unknown>, run: (error: unknown) => void): void {
	promise.then(undefined, run);
}

export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function codeOf(error: unknown): string | undefined {
	const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
	return typeof code === "string" ? code : undefined;
}

export function orLogged<T, F>(promise: Promise<T>, event: string, fallback: F, fields: Record<string, string> = {}): Promise<T | F> {
	return promise.then(
		(value) => value,
		(error: unknown) => {
			log.warn(event, { ...fields, error: messageOf(error) });
			return fallback;
		},
	);
}
