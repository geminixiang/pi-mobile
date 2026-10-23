import { defineExtension, section } from "@earendil-works/pi-durable";

export function createOnDemandExtension(label: (extension: string, conversationId: string) => string | undefined) {
	return defineExtension({
		name: "on-demand",
		sections: [
			section("on-demand", (input) => {
				const deferred = new Set(input.agent.deferred.map((tool) => tool.name));
				const lines = input.agent.extensions.flatMap((extension) => {
					const names = (extension.tools ?? []).map((tool) => tool.name).filter((name) => deferred.has(name));
					const name = label(extension.name, String(input.conversationId));
					return names.length > 0 && name ? [`- ${name}: ${names.join(", ")}`] : [];
				});
				if (lines.length === 0) return undefined;
				return [
					"Load these with tool_search before calling them:",
					...lines,
				].join("\n");
			}),
		],
	});
}
