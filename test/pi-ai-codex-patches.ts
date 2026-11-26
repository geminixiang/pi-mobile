import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { patchCodexResponses } from "../vite-plugins/pi-ai-codex.ts";

const source = readFileSync(new URL("../node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js", import.meta.url), "utf8");
const patched = patchCodexResponses(source);

assert(!patched.includes("new WebSocketCtor(url, { headers"), "pi-ai still opens its WebSocket with a headers object, which a browser takes as an invalid subprotocol");
assert(patched.includes("new WebSocketCtor(withKeyInQuery(url, wsHeaders.authorization))"), "the WebSocket does not carry the key in ?key=");
assert(!patched.includes(`throw new Error("Failed to extract accountId from token")`), "a plain API key still fails before any request");

for (const target of [`throw new Error("Failed to extract accountId from token");`, `socket = new WebSocketCtor(url, { headers: wsHeaders });`]) {
	assert.throws(() => patchCodexResponses(source.replace(target, "")), /recheck vite-plugins\/pi-ai-codex\.ts/, `a pi-ai without ${target} was patched silently`);
}

console.log("pi-ai codex patches: a plain key works, and a browser WebSocket carries it in ?key=");
