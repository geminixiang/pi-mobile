import { type PromptSection, section, type ToolRegistration } from "@earendil-works/pi-durable";
import { log } from "../log.ts";

export const PROMPT_BUDGET = 24_000;
const CUT = "\n… (cut to fit the prompt)";
const budgets = new Map<string, number>();

export function budgetOf(key: string): number | undefined {
	return budgets.get(key) ?? (key.startsWith("mcp-") ? budgets.get("mcp-") : undefined);
}

export function fit(text: string, budget: number): string {
	if (text.length <= budget) return text;
	const room = budget - CUT.length;
	const end = text.lastIndexOf("\n", room);
	return text.slice(0, end > 0 ? end : room) + CUT;
}

export function appSection<Tool extends ToolRegistration = ToolRegistration>(
	key: string,
	budget: number,
	render: PromptSection<Tool>["render"],
	{ about, ...options }: { readonly tag?: boolean; readonly about?: readonly { readonly name: string }[] } = {},
): PromptSection<Tool> {
	budgets.set(key.startsWith("mcp-") ? "mcp-" : key, budget);
	const offered = (agent: { tools: readonly Tool[]; callable: readonly Tool[]; deferred: readonly Tool[] }) => {
		const names = new Set([...agent.tools, ...agent.callable, ...agent.deferred].map((tool) => tool.name));
		return about === undefined || about.some((tool) => names.has(tool.name));
	};
	return section<Tool>(
		key,
		async (input, context) => {
			if (!offered(input.agent)) return undefined;
			const text = await render(input, context);
			if (text === undefined || text.length <= budget) return text;
			log.warn("prompt.section_over_budget", { section: key, chars: String(text.length), budget: String(budget) });
			return fit(text, budget);
		},
		options,
	);
}
