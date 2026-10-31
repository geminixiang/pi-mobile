const SCREEN_TOOLS = new Set(["read_page", "use_browser", "read_phone_screen", "use_phone_screen"]);
const STOPPED = "Stopped at ";
const WAITS = new Set(["wait", "wait_for"]);

export function preview(name: string, lines: string[]): { shown: string[]; hidden: number } {
	if (name === "read") return { shown: [], hidden: 0 };
	if (SCREEN_TOOLS.has(name)) {
		const stopped = lines.filter((line) => line.startsWith(STOPPED)).map((line) => line.slice(STOPPED.length).split("; the steps before it ran")[0] ?? "");
		return { shown: stopped, hidden: 0 };
	}
	if (name === "bash" || name === "codemode") return { shown: lines.slice(-5), hidden: Math.max(0, lines.length - 5) };
	return { shown: lines.slice(0, 10), hidden: Math.max(0, lines.length - 10) };
}

export function stepsLabel(steps: unknown): string | undefined {
	if (!Array.isArray(steps)) return undefined;
	const named = steps.flatMap((step: unknown) => {
		if (typeof step !== "object" || step === null) return [];
		const action = Reflect.get(step, "action");
		if (typeof action !== "string" || WAITS.has(action)) return [];
		const target = Reflect.get(step, "url") ?? Reflect.get(step, "app");
		return [action === "open" && typeof target === "string" ? `open ${target.replace(/^https?:\/\//, "")}` : action];
	});
	const runs = named.reduce<{ name: string; count: number }[]>((acc, name) => {
		const last = acc.at(-1);
		if (last?.name === name) last.count += 1;
		else acc.push({ name, count: 1 });
		return acc;
	}, []);
	return runs.map((run) => (run.count > 1 ? `${run.name} ×${run.count}` : run.name)).join(" · ");
}
