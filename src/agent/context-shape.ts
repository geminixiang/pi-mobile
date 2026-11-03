import type { Message } from "@earendil-works/pi-ai";

export type ContextShape = { sections: Readonly<Record<string, number>>; messages: number };

export type ToolCost = Record<string, { offered: number; deferred: number; tools: string[] }>;

export type ContextPart = { kind: "messages" | "prompt" | "memory" | "tools" | "services"; tokens: number; items: { name: string; tokens: number }[] };

export type ContextParts = { parts: ContextPart[]; reserve: number; free: number; deferred: number };

const MEMORY_SECTION = "memory";
const isService = (name: string) => name.startsWith("mcp-");

export function shapeOf(messages: readonly Message[]): ContextShape {
	const sections: Record<string, number> = {};
	let chars = 0;
	for (const message of messages) {
		if (message.role !== "system") {
			chars += JSON.stringify(message.content).length;
			continue;
		}
		for (const [name, text] of Object.entries(message.sections ?? {})) {
			if (text === null) delete sections[name];
			else sections[name] = text.length;
		}
	}
	return { sections, messages: chars };
}

export function contextParts(shape: ContextShape, tools: ToolCost, used: number, window: number, compactAt: number): ContextParts {
	const sections = Object.entries(shape.sections);
	const offered = Object.entries(tools).filter(([, cost]) => cost.offered > 0);
	const chars = shape.messages + sections.reduce((sum, [, size]) => sum + size, 0) + offered.reduce((sum, [, cost]) => sum + cost.offered, 0);
	const perChar = chars > 0 ? used / chars : 0;
	const items = (list: [string, number][]) => list.map(([name, size]) => ({ name, tokens: Math.round(size * perChar) })).toSorted((a, b) => b.tokens - a.tokens);
	const part = (kind: ContextPart["kind"], list: [string, number][]): ContextPart => {
		const named = items(list);
		return { kind, tokens: named.reduce((sum, item) => sum + item.tokens, 0), items: named };
	};
	const messages: ContextPart = { kind: "messages", tokens: Math.round(shape.messages * perChar), items: [] };
	const parts = [
		messages,
		part("prompt", sections.filter(([name]) => name !== MEMORY_SECTION && !isService(name))),
		part("memory", sections.filter(([name]) => name === MEMORY_SECTION)),
		part(
			"tools",
			offered.filter(([name]) => !isService(name)).map(([name, cost]): [string, number] => [name, cost.offered]),
		),
		part("services", [...sections.filter(([name]) => isService(name)), ...offered.filter(([name]) => isService(name)).map(([name, cost]): [string, number] => [name, cost.offered])]),
	].filter((entry) => entry.tokens > 0);
	const reserve = compactAt > 0 && compactAt < window ? window - compactAt : 0;
	const deferred = Math.round(Object.values(tools).reduce((sum, cost) => sum + cost.deferred, 0) * perChar);
	return { parts, reserve, free: Math.max(0, window - used - reserve), deferred };
}
