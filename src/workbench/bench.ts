export type Tab = { kind: "bot" } | { kind: "folder" } | { kind: "file"; path: string };

export type Bench = { bot: string | undefined; tabs: readonly Tab[]; active: string };

export type BenchAction = { type: "show"; bot: string; tab: Tab } | { type: "close"; bot: string; key: string };

export const MAX_TABS = 8;

export const BOT_TAB: Tab = { kind: "bot" };

export const keyOf = (tab: Tab): string => (tab.kind === "file" ? `file:${tab.path}` : tab.kind);

export const emptyBench = (bot: string | undefined): Bench => ({ bot, tabs: [BOT_TAB], active: keyOf(BOT_TAB) });

export function benchOf(bench: Bench, bot: string | undefined): Bench {
	return bench.bot === bot ? bench : emptyBench(bot);
}

export function inView(bench: Bench): string | undefined {
	const active = bench.tabs.find((tab) => keyOf(tab) === bench.active);
	return active?.kind === "file" ? active.path : undefined;
}

export function benchStep(state: Bench, action: BenchAction): Bench {
	const bench = benchOf(state, action.bot);
	if (action.type === "show") {
		const key = keyOf(action.tab);
		if (bench.tabs.some((tab) => keyOf(tab) === key)) return { ...bench, active: key };
		const opened = [...bench.tabs, action.tab];
		const extra = opened.length - MAX_TABS;
		const kept = extra > 0 ? opened.filter((tab, index) => tab.kind === "bot" || index > extra) : opened;
		return { ...bench, tabs: kept, active: key };
	}
	const index = bench.tabs.findIndex((tab) => keyOf(tab) === action.key);
	if (index <= 0) return bench;
	const tabs = bench.tabs.filter((_, other) => other !== index);
	if (bench.active !== action.key) return { ...bench, tabs };
	const next = tabs[index] ?? tabs[index - 1] ?? BOT_TAB;
	return { ...bench, tabs, active: keyOf(next) };
}
