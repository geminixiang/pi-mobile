// The tools a bot can load on demand, named in its prompt: deferred tools are not offered to the model, so without
// this it would not know they exist. One line per toolset, from the bot's own resolved agent, so only what it has
// turned on is listed; tool_search loads them, and loaded ones are offered from then on and drop out of the list.
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
