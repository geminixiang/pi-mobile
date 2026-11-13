export type Bench = { bot: string | undefined; pick: string | undefined; opened: readonly string[] };

export type BenchAction = { type: "show"; bot: string; key: string } | { type: "close"; bot: string; key: string };

export const MAX_OPENED = 8;

export const FOLDER = "folder";

const FILE = "file:";

export const fileKey = (path: string): string => `${FILE}${path}`;

export const pathOf = (key: string | undefined): string | undefined => (key?.startsWith(FILE) ? key.slice(FILE.length) : undefined);

export const emptyBench = (bot: string | undefined): Bench => ({ bot, pick: undefined, opened: [] });

export function benchOf(bench: Bench, bot: string | undefined): Bench {
	return bench.bot === bot ? bench : emptyBench(bot);
}

export function benchStep(state: Bench, action: BenchAction): Bench {
	const bench = benchOf(state, action.bot);
	const path = pathOf(action.key);
	const others = path === undefined ? bench.opened : bench.opened.filter((opened) => opened !== path);
	if (action.type === "show") return { ...bench, pick: action.key, opened: path === undefined ? others : [...others, path].slice(-MAX_OPENED) };
	return { ...bench, pick: bench.pick === action.key ? undefined : bench.pick, opened: others };
}
