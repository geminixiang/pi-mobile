// The tools a bot can load on demand, named in its prompt: deferred tools are not offered to the model, so without
// this it would not know they exist. One line per toolset, from the bot's own resolved agent, so only what it has
// turned on is listed; tool_search loads them, and loaded ones are offered from then on and drop out of the list.
import { defineExtension, section } from "@earendil-works/pi-durable";

export function createOnDemandExtension(label: (extension: string) => string) {
	return defineExtension({
		name: "on-demand",
		sections: [
			section("on-demand", (input) => {
				const deferred = new Set(input.agent.deferred.map((tool) => tool.name));
				if (deferred.size === 0) return undefined;
				const lines = input.agent.extensions.flatMap((extension) => {
					const names = (extension.tools ?? []).map((tool) => tool.name).filter((name) => deferred.has(name));
					return names.length > 0 ? [`- ${label(extension.name)}: ${names.join(", ")}`] : [];
				});
				return [
					"These tools are yours but load on demand: call tool_search with what you need (a toolset's name or the task) to load the ones a task needs, then call them. Do not answer from memory what one of them would look up.",
					...lines,
				].join("\n");
			}),
		],
	});
}
