import assert from "node:assert/strict";
import type { Message } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { customProvider } from "../src/agent/models.ts";
import { checkedRoute, type EndpointAdapter } from "../src/agent/providers/route.ts";
import { fakeProxy, KEY } from "./fake-cliproxy.ts";

type Seen = { recognized: string[]; verified: string[]; adapted: string[] };
type Behaviour = { recognizes: boolean; verdict: true | string };

const PLAIN_CALL = "POST /v1/chat/completions";
const user = (content: string): Message => ({ role: "user", content, timestamp: Date.now() });

function adapter(id: string, seen: Seen, { recognizes, verdict }: Behaviour): EndpointAdapter {
	return {
		id,
		recognize: async () => {
			seen.recognized.push(id);
			return recognizes;
		},
		adapt: (model) => {
			seen.adapted.push(id);
			return model;
		},
		verify: async () => {
			seen.verified.push(id);
			return verdict;
		},
	};
}

async function endpoint(adapters?: (seen: Seen) => EndpointAdapter[], identity = "Another Gateway") {
	const proxy = await fakeProxy();
	proxy.identity = identity;
	const seen: Seen = { recognized: [], verified: [], adapted: [] };
	const provider = customProvider({ id: "gw", name: "gw", baseUrl: `${proxy.root}/v1` }, KEY, ["m"], new Map(), adapters?.(seen));
	const model = provider.getModels()[0];
	assert(model);
	const ask = (content: string) => provider.streamSimple(model, normalizeContext({ messages: [user(content)] }), { apiKey: KEY, sessionId: "s1" }).result();
	const route = async () => {
		await ask("first call");
		const decided = await checkedRoute({ root: proxy.root, apiKey: KEY });
		return decided.kind === "adapted" ? decided.adapter.id : decided.reason;
	};
	return { proxy, seen, ask, route };
}

const checks: [string, () => Promise<void>][] = [
	[
		"an endpoint no adapter recognizes stays plain, and no adapter verifies or adapts a call",
		async () => {
			const { proxy, seen, ask, route } = await endpoint((seen) => [adapter("a", seen, { recognizes: false, verdict: true }), adapter("b", seen, { recognizes: false, verdict: true })]);
			assert.equal(await route(), "no adapter recognizes it");
			await ask("again");
			assert.deepEqual(seen, { recognized: ["a", "b"], verified: [], adapted: [] });
			assert.deepEqual(proxy.httpCalls, [PLAIN_CALL, PLAIN_CALL]);
			proxy.close();
		},
	],
	[
		"with the app's adapters, a server none of them recognizes gets only its own calls: no model call checks it",
		async () => {
			const { proxy, ask, route } = await endpoint();
			assert.equal(await route(), "no adapter recognizes it");
			await ask("again");
			assert.deepEqual(proxy.httpCalls, [PLAIN_CALL, PLAIN_CALL]);
			assert.equal(proxy.frames.length, 0);
			proxy.close();
		},
	],
	[
		"when two adapters recognize an endpoint, the first in the list wins and the second is never asked",
		async () => {
			const both = (first: string, second: string) => (seen: Seen) => [adapter(first, seen, { recognizes: true, verdict: true }), adapter(second, seen, { recognizes: true, verdict: true })];
			const ab = await endpoint(both("a", "b"));
			assert.equal(await ab.route(), "a");
			await ab.ask("again");
			assert.deepEqual(ab.seen, { recognized: ["a"], verified: ["a"], adapted: ["a"] });
			const ba = await endpoint(both("b", "a"));
			assert.equal(await ba.route(), "b");
			ab.proxy.close();
			ba.proxy.close();
		},
	],
	[
		"an adapter that recognizes but fails to verify gives way to the next one",
		async () => {
			const { proxy, seen, route } = await endpoint((seen) => [adapter("a", seen, { recognizes: true, verdict: "keeps no history" }), adapter("b", seen, { recognizes: true, verdict: true })]);
			assert.equal(await route(), "b");
			assert.deepEqual(seen.verified, ["a", "b"]);
			proxy.close();
		},
	],
	[
		"when every adapter that recognizes fails to verify, the endpoint stays plain with each one's reason",
		async () => {
			const { proxy, route } = await endpoint((seen) => [adapter("a", seen, { recognizes: true, verdict: "keeps no history" }), adapter("b", seen, { recognizes: true, verdict: "refused the key" })]);
			assert.equal(await route(), "a: keeps no history; b: refused the key");
			proxy.close();
		},
	],
];

for (const [name, run] of checks) {
	await run().catch((error: unknown) => {
		console.error(`adapters: ${name}\n`, error);
		process.exit(1);
	});
}
console.log("adapters: an endpoint no adapter recognizes stays plain with no model call; the list's order decides between adapters, and one that fails to verify gives way to the next");
process.exit(0);
