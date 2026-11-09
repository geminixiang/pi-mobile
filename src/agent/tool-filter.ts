import { AgentDoc, defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";

export const ToolFilterExtension = defineExtension({
	name: "tool-filter",
	hooks: [
		hook(ToolTask, {
			afterTool: async (_call, result, api, context) => {
				const added = result.control?.addTools;
				if (!added || added.length === 0) return undefined;
				const stored = (await api.snapshot(AgentDoc, api.conversationId, context))?.tools;
				const removed = new Set(stored === undefined || Array.isArray(stored) ? [] : stored.remove);
				return { ...result, control: { ...result.control, addTools: added.filter((name) => !removed.has(name)) } };
			},
		}),
	],
});
