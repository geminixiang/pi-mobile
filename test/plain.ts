export function plain(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(plain);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([, inner]) => typeof inner !== "function")
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, inner]) => [key, plain(inner)]),
	);
}
