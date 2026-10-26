export const NULL_BODY_STATUS: ReadonlySet<number> = new Set([101, 204, 205, 304]);

export function headerRecord(...sources: (HeadersInit | undefined)[]): Record<string, string> {
	const merged = new Headers();
	for (const source of sources) new Headers(source).forEach((value, key) => merged.set(key, value));
	return Object.fromEntries(merged);
}
