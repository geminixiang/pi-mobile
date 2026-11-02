import assert from "node:assert/strict";
import { RENAMED, renamed, TOOLSETS } from "../src/agent/toolsets.ts";

const current = new Set(TOOLSETS.flatMap((toolset) => toolset.extensions));
assert.deepEqual(renamed({ add: ["mcp-notes"], remove: ["phone_screen", "sandbox", "coding-tools", "web"] }), { add: ["mcp-notes"], remove: ["phone_as_user", "computer_shell", "coding-tools", "web"] });
assert.deepEqual(renamed({ add: [], remove: ["phone_as_user"] }), { add: [], remove: ["phone_as_user"] });
for (const [old, next] of Object.entries(RENAMED)) {
	assert(!current.has(old), `${old} was renamed, so no toolset may use it again: a bot that turned it off would find it off`);
	assert(current.has(next), `${old} is renamed to ${next}, which no toolset has`);
}
console.log("toolsets: a bot's choices made under an old extension name carry over to the new name");
