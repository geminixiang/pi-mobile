import { defineExtension } from "@earendil-works/pi-durable";
import { appSection } from "../section.ts";

export function createOnDemandExtension(label: (tool: string, extension: string, conversationId: string) => string | undefined) {
	return defineExtension({
		name: "on-demand",
		sections: [
			appSection("on-demand", 800, (input) => {
				const deferred = new Set(input.agent.deferred.map((tool) => tool.name));
				const grouped = new Map<string, { names: string[]; use: string }>();
				for (const extension of input.agent.extensions) {
					for (const tool of (extension.tools ?? []).filter((candidate) => deferred.has(candidate.name))) {
						const name = label(tool.name, extension.name, String(input.conversationId));
						if (name) grouped.set(name, { names: [...(grouped.get(name)?.names ?? []), tool.name], use: grouped.get(name)?.use ?? firstClause(tool.description) });
					}
				}
				const lines = [...grouped].map(([name, { names, use }]) => `- ${name} (${use}): ${names.join(", ")}`);
				if (lines.length === 0) return undefined;
				return [
					"Load these with tool_search before calling them:",
					...lines,
				].join("\n");
			}),
		],
	});
}

function firstClause(description: string): string {
	const end = description.search(/[.;](\s|$)/u);
	return (end < 0 ? description : description.slice(0, end)).slice(0, USE_CHARS);
}

const USE_CHARS = 110;
