import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { memoryCredentials } from "../../src/agent/credentials.ts";
import { runFailureNote } from "../../src/agent/entries.ts";
import { customProvider } from "../../src/agent/models.ts";
import { AgentRuntime } from "../../src/agent/runtime.ts";
import { liveOf } from "../../src/app/docs.ts";
import { isConfigured, type Settings } from "../../src/settings.ts";
import { type Check, platform, settings, settle } from "./setup.ts";

const withProvider = (baseUrl: string): Settings => ({ ...settings, providers: [{ kind: "custom", id: "custom", name: "", baseUrl }], providerKeys: {}, providerOAuth: {} });

export const checks: Check[] = [
	[
		"a custom endpoint with no address is not enough to start, the same way its form says so",
		async () => {
			assert.equal(isConfigured(withProvider("")), false);
			assert.equal(isConfigured(withProvider("http://localhost:8399")), true);
		},
	],
	[
		"a custom endpoint whose key is optional still gives the model request a key to send",
		async () => {
			const provider = customProvider({ id: "custom", name: "", baseUrl: "https://model.invalid" }, "", ["m"], new Map());
			const models = createModels({ credentials: memoryCredentials({}, {}, () => undefined) });
			models.setProvider(provider);
			const [model] = provider.getModels();
			assert(model);
			const resolved = await models.getAuth(model);
			assert(resolved?.auth?.apiKey, "pi-ai refuses the request with No API key for provider");
		},
	],
	[
		"a message no model can answer says why at the end of the conversation, instead of nothing",
		async () => {
			const noModels = { ...platform, models: async () => ({ models: createModels({ credentials: memoryCredentials({}, {}, () => undefined) }), infos: [], webSearch: { baseUrl: "", apiKey: "", modelIds: [] } }) };
			const runtime = await AgentRuntime.open(new MemoryStorage(), settings, noModels, {});
			try {
				const [bot] = await runtime.bots();
				assert(bot);
				const conversation = await runtime.openConversation(bot.id);
				await conversation.send([{ type: "text", text: "hello" }]);
				await settle();
				let view;
				conversation.subscribe((next) => (view = next))();
				conversation.dispose();
				assert.match(runFailureNote(liveOf(view)) ?? "", /模型/);
			} finally {
				await runtime.close();
			}
		},
	],
];
