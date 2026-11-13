export type Rates = { up: number; down: number };
export type Direction = keyof Rates;

export interface Traffic {
	rates(): Rates;
	onChange(listener: () => void): () => void;
	count(direction: Direction, bytes: number): void;
}

const WINDOW_MS = 1000;
export const STILL: Rates = { up: 0, down: 0 };
const encoder = new TextEncoder();

export function bytesOf(data: string | ArrayBuffer | Uint8Array): number {
	return typeof data === "string" ? encoder.encode(data).byteLength : data.byteLength;
}

export function createTraffic(windowMs = WINDOW_MS, now: () => number = Date.now): Traffic {
	const listeners = new Set<() => void>();
	const moved: { at: number; direction: Direction; bytes: number }[] = [];
	let shown = STILL;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const publish = () => {
		const since = now() - windowMs;
		const fresh = moved.findIndex((entry) => entry.at > since);
		moved.splice(0, fresh === -1 ? moved.length : fresh);
		const bytes = moved.reduce((sum, entry) => ({ ...sum, [entry.direction]: sum[entry.direction] + entry.bytes }), STILL);
		shown = bytes === STILL ? STILL : { up: (bytes.up * 1000) / windowMs, down: (bytes.down * 1000) / windowMs };
		timer = moved.length > 0 ? setTimeout(publish, windowMs / 2) : undefined;
		for (const listener of listeners) listener();
	};
	return {
		rates: () => shown,
		onChange: (listener) => {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		count: (direction, bytes) => {
			if (bytes <= 0) return;
			moved.push({ at: now(), direction, bytes });
			if (timer === undefined) publish();
		},
	};
}

function keyed(): (key: string) => Traffic {
	const all = new Map<string, Traffic>();
	return (key) => {
		const known = all.get(key);
		if (known) return known;
		const created = createTraffic();
		all.set(key, created);
		return created;
	};
}

export const modelTraffic = keyed();
export const hostTraffic = keyed();
