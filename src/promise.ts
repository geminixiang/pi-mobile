import { log } from "./log.ts";

export function settled(promise: Promise<unknown>): Promise<void> {
	return promise.then(
		() => undefined,
		() => undefined,
	);
}

export function onFailure(promise: Promise<unknown>, run: (error: unknown) => void): void {
	promise.then(undefined, run);
}

export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
