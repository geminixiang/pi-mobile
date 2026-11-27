import assert from "node:assert/strict";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { Type } from "typebox";
import { customProvider } from "../src/agent/models.ts";
import { checkedRoute } from "../src/agent/providers/route.ts";
import { type FakeProxy, fakeProxy, KEY } from "./fake-cliproxy.ts";
import { sleep } from "pi-mobile-base/time";

const CLOSE_SEEN_MS = 100;
const LOOKUP = { name: "lookup", description: "Looks a value up.", parameters: Type.Object({}) };

const user = (content: string): Message => ({ role: "user", content, timestamp: Date.now() });
const OFFICIAL = { kind: "adapted", adapter: "cliproxyapi" };
const shown = (route: Awaited<ReturnType<typeof checkedRoute>>) => (route.kind === "adapted" ? { kind: route.kind, adapter: route.adapter.id } : route);
const textOf = (message: AssistantMessage) => message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

async function endpoint(apiKey = KEY, set: (proxy: FakeProxy) => void = () => {}) {
	const proxy = await fakeProxy();
	set(proxy);
	const provider = customProvider({ id: "cpa", name: "cpa", baseUrl: `${proxy.root}/v1` }, apiKey, ["m"], new Map());
	const model = provider.getModels()[0];
	assert(model);
	const ask = (messages: Message[], sessionId: string) => provider.streamSimple(model, normalizeContext({ messages, tools: [LOOKUP] }), { apiKey, sessionId }).result();
	const checked = async () => {
		await ask([user("first call")], "first");
		return shown(await checkedRoute({ root: proxy.root, apiKey }));
	};
	return { proxy, ask, checked };
}

async function officialEndpoint() {
	const reached = await endpoint();
	assert.deepEqual(await reached.checked(), OFFICIAL);
	reached.proxy.frames.length = 0;
	reached.proxy.httpCalls.length = 0;
	return reached;
}

const checks: [string, () => Promise<void>][] = [
	[
		"a CLI Proxy API Server that keeps history: the first call goes the plain way while it is checked, then a session's second call sends only the new input on the socket",
		async () => {
			const { proxy, ask, checked } = await endpoint();
			const route = await checked();
			assert.deepEqual(route, OFFICIAL);
			assert.equal(proxy.httpCalls.length, 1, "the call made while the endpoint was unchecked did not go the plain way");
			assert.equal(proxy.frames.length, 2, "the check is two calls on one socket");
			proxy.frames.length = 0;
			const notes = "notes ".repeat(500);
			const first = [user(`ledger: ${notes}`)];
			const answer = await ask(first, "s1");
			const second = await ask([...first, answer, user("and the total?")], "s1");
			assert.equal(proxy.httpCalls.length, 1, "a call on the official route went over HTTP");
			const [full, delta] = proxy.frames;
			assert(full && delta);
			assert.equal(full.previousResponseId, undefined);
			assert.equal(delta.previousResponseId, "resp_1");
			assert.equal(delta.inputItems, 1, "the second call resent the conversation");
			assert(delta.bytes * 5 < full.bytes, `the delta (${delta.bytes} B) is not much smaller than the full request (${full.bytes} B)`);
			assert(textOf(second).includes("ledger"), "the proxy answered the delta without the history");
			proxy.close();
		},
	],
	[
		"a server that drops previous_response_id stays on the plain route",
		async () => {
			const { proxy, ask, checked } = await endpoint(KEY, (fixture) => (fixture.forgets = true));
			const route = await checked();
			assert.equal(route.kind, "plain");
			assert.match(route.kind === "plain" ? route.reason : "", /drops previous_response_id/);
			await ask([user("hello")], "s1");
			assert.equal(proxy.httpCalls.length, 2);
			proxy.close();
		},
	],
	[
		"an endpoint that is not a CLI Proxy API Server is never asked over a socket",
		async () => {
			const { proxy, checked } = await endpoint(KEY, (fixture) => (fixture.identity = "Another Gateway"));
			assert.deepEqual(await checked(), { kind: "plain", reason: "no adapter recognizes it" });
			assert.equal(proxy.frames.length, 0);
			proxy.close();
		},
	],
	[
		"a key the socket refuses leaves the endpoint on the plain route",
		async () => {
			const { proxy, checked } = await endpoint("wrong-key");
			assert.equal((await checked()).kind, "plain");
			assert.equal(proxy.frames.length, 0);
			proxy.close();
		},
	],
	[
		"a check that cannot reach the server is not remembered, so the next call checks again",
		async () => {
			const { proxy, checked } = await endpoint();
			proxy.close();
			const route = await checked();
			assert.equal(route.kind, "plain");
			assert.deepEqual(await checkedRoute({ root: proxy.root, apiKey: KEY }), { kind: "plain", reason: "not checked yet" }, "an unreachable server was remembered as not a CLI Proxy API Server");
		},
	],
	[
		"when the official route fails, the call is answered the plain way and the endpoint is checked again",
		async () => {
			const { proxy, ask } = await officialEndpoint();
			proxy.refusesSockets = true;
			proxy.dropSockets();
			const answer = await ask([user("hello")], "s1");
			assert.equal(answer.stopReason, "stop");
			assert.equal(textOf(answer), "plain");
			assert.deepEqual(proxy.httpCalls, ["POST /v1/chat/completions"]);
			assert.equal((await checkedRoute({ root: proxy.root, apiKey: KEY })).kind, "plain", "a failed official route was still used");
			await ask([user("again")], "s1");
			assert.equal((await checkedRoute({ root: proxy.root, apiKey: KEY })).kind, "plain");
			proxy.close();
		},
	],
	[
		"after the socket drops, the next call of a session sends the whole conversation once, then deltas again",
		async () => {
			const { proxy, ask } = await officialEndpoint();
			const first = [user("remember ORCHID")];
			const answer = await ask(first, "s1");
			proxy.dropSockets();
			await sleep(CLOSE_SEEN_MS);
			const again = [...first, answer, user("what was it?")];
			const second = await ask(again, "s1");
			const third = await ask([...again, second, user("and now?")], "s1");
			assert.deepEqual(
				proxy.frames.map((frame) => frame.previousResponseId === undefined),
				[true, true, false],
			);
			assert(textOf(third).includes("ORCHID"));
			assert.equal(proxy.httpCalls.length, 0);
			proxy.close();
		},
	],
	[
		"a tool's result goes out as a delta naming the call id the proxy sent, so the proxy can pair them",
		async () => {
			const { proxy, ask } = await officialEndpoint();
			const first = [user("use the tool")];
			const call = await ask(first, "s1");
			const toolCall = call.content.find((part) => part.type === "toolCall");
			assert(toolCall, "the fixture's function call did not arrive as a tool call");
			const result: Message = { role: "toolResult", toolCallId: toolCall.id, toolName: "lookup", content: [{ type: "text", text: "42" }], isError: false, timestamp: Date.now() };
			await ask([...first, call, result], "s1");
			const delta = proxy.frames[1];
			assert(delta);
			assert.equal(delta.previousResponseId, "resp_1");
			assert.deepEqual(delta.toolOutputsFor, ["call_1"]);
			proxy.close();
		},
	],
];

for (const [name, run] of checks) {
	await run().catch((error: unknown) => {
		console.error(`cliproxyapi: ${name}\n`, error);
		process.exit(1);
	});
}
console.log("cliproxyapi: a CLI Proxy API Server that keeps history takes its official route, sending a session's next calls as deltas; any other endpoint, a server that forgets, a refused key or a failed call goes the plain way");
process.exit(0);
