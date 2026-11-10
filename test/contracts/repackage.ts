import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, type Extension, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { builtinExtensions } from "../../src/agent/catalog.ts";
import { DEFAULT_CALENDAR_ACCESS } from "../../src/agent/calendar-access.ts";
import { memoryCredentials } from "../../src/agent/credentials.ts";
import { declarationOf } from "../../src/agent/tools/common.ts";
import { type Groups, removedTools } from "../../src/agent/toolsets.ts";
import { type Check, platform } from "./setup.ts";

const { extensions } = builtinExtensions({
	userSaid: async () => [],
	native: platform.native,
	assistant: defineExtension({ name: "assistant" }),
	calendarAccess: DEFAULT_CALENDAR_ACCESS,
	clouds: [],
	web: { baseUrl: "", apiKey: "", modelIds: [] },
	triggers: { changed: () => undefined, unattended: () => false, notify: async () => "shown" },
	memory: { changed: () => undefined },
	workplace: () => undefined,
	waitForJob: () => undefined,
	labelOf: (tool) => tool,
	actsAsUser: async () => false,
	permissions: { state: async () => "granted", request: async () => true },
	ask: async () => ({ action: "cancel" }),
});

function ownersOf(list: readonly Extension[]): Map<string, Groups> {
	return new Map(list.flatMap((extension) => (extension.tools ?? []).map((tool) => [tool.name, declarationOf(tool)?.groups ?? assert.fail(`${tool.name} has no groups`)] as const)));
}

async function toolsOf(list: readonly Extension[], off: readonly string[]) {
	const registry = createRegistry();
	for (const extension of list) registry.install(extension);
	const harness = await Harness.open(new MemoryStorage(), { models: createModels({ credentials: memoryCredentials({}, {}, () => undefined) }), registry, settings: { extensions: [...list] } }, BACKGROUND_CONTEXT);
	try {
		const removed = removedTools(ownersOf(list), off, "phone", platform.native);
		const remove = list.flatMap((extension) => extension.tools ?? []).filter((tool) => removed.includes(tool.name));
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { tools: { remove } } }, BACKGROUND_CONTEXT);
		const agent = await conversation.agent(BACKGROUND_CONTEXT);
		const names = (tools: readonly { name: string }[]) => tools.map((tool) => tool.name).sort();
		return { tools: names(agent.tools), callable: names(agent.callable), deferred: names(agent.deferred) };
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
}

const named = (name: string) => extensions.find((extension) => extension.name === name) ?? assert.fail(`${name} is not in the catalog`);

export const checks: Check[] = [
	[
		"renaming, merging and moving extensions leaves every tool's toolsets and a bot's tools as they were, so a bot's choices never depend on how tools are packaged",
		async () => {
			const weather = named("weather");
			const places = named("places");
			const stocks = named("tw_stocks");
			const codemode = named("codemode");
			const repackaged = [
				...extensions.filter((extension) => ![weather, places, stocks, codemode].includes(extension)),
				{ ...weather, name: "forecast_and_places", tools: [...(weather.tools ?? []), ...(places.tools ?? [])], sections: [...(weather.sections ?? []), ...(places.sections ?? [])] },
				{ ...codemode, tools: [...(codemode.tools ?? []), ...(stocks.tools ?? [])] },
			];
			assert.deepEqual(ownersOf(repackaged), ownersOf(extensions));
			const off = ["places", "tw_stocks"];
			const before = await toolsOf(extensions, off);
			const after = await toolsOf(repackaged, off);
			assert.deepEqual(after, before);
			assert.ok(before.callable.includes("weather"));
			for (const tool of ["find_places", "tw_stocks"]) assert.ok(!after.callable.includes(tool), `${tool} stays off inside another extension`);
		},
	],
];
