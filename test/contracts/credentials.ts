import assert from "node:assert/strict";
import { memoryCredentials } from "../../src/agent/credentials.ts";
import type { Check } from "./setup.ts";

export const checks: Check[] = [
	[
		"a write that changes nothing keeps the credential, as when another request already refreshed a sign-in",
		async () => {
			const store = await memoryCredentials({ openai: "sk-contract" }, {});
			const kept = await store.modify("openai", async () => undefined);
			assert.deepEqual(kept, { type: "api_key", key: "sk-contract" });
			assert.deepEqual(await store.read("openai"), { type: "api_key", key: "sk-contract" });
		},
	],
	[
		"a new sign-in is stored and handed back to be saved",
		async () => {
			const saved: string[] = [];
			const store = await memoryCredentials({}, {}, (providerId) => saved.push(providerId));
			const credential = { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 } as const;
			await store.modify("openai", async () => credential);
			assert.deepEqual(await store.read("openai"), credential);
			assert.deepEqual(saved, ["openai"]);
		},
	],
];
