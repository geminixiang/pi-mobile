import assert from "node:assert/strict";
import type { Message } from "@earendil-works/pi-ai";
import { contextParts, shapeOf } from "../src/agent/context-shape.ts";

const messages: Message[] = [
	{ role: "system", content: "", sections: { preamble: "p".repeat(400), memory: "m".repeat(100), bot: "b".repeat(300) }, timestamp: 0 },
	{ role: "user", content: "x".repeat(200), timestamp: 0 },
	{ role: "system", content: "", sections: { bot: "b".repeat(200), "mcp-web": "w".repeat(100), gone: null }, timestamp: 0 },
];
const shape = shapeOf(messages);
assert.deepEqual(shape.sections, { preamble: 400, memory: 100, bot: 200, "mcp-web": 100 });
assert.equal(shape.messages, 200);

const photo: Message = { role: "user", content: [{ type: "text", text: "x".repeat(50) }, { type: "image", mimeType: "image/jpeg", data: "z".repeat(900_000) }], timestamp: 0 };
assert.equal(shapeOf([photo]).messages, 50 + 6_400);

const tools = { codemode: { offered: 400, deferred: 0, tools: ["codemode"] }, "mcp-web": { offered: 300, deferred: 0, tools: ["web_fetch"] }, phone: { offered: 0, deferred: 600, tools: ["phone_read"] } };
const parts = contextParts(shape, tools, 1700, 10_000, 9000);
assert.deepEqual(
	parts.parts.map((part) => [part.kind, part.tokens]),
	[
		["messages", 200],
		["prompt", 600],
		["memory", 100],
		["tools", 400],
		["services", 400],
	],
);
assert.deepEqual(parts.parts.find((part) => part.kind === "prompt")?.items.map((item) => item.name), ["preamble", "bot"]);
assert.equal(parts.reserve, 1000);
assert.equal(parts.free, 10_000 - 1700 - 1000);
assert.equal(parts.deferred, 600);
console.log("context shape: later system messages replace or drop sections, an image counts as one image, not its base64, and the parts of a request add up to its real token count");
