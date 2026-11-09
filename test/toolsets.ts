import assert from "node:assert/strict";
import { type Groups, legacyOff, removedTools } from "../src/agent/toolsets.ts";

assert.deepEqual(legacyOff(undefined), []);
assert.deepEqual(legacyOff({ add: ["mcp-notes"] }), []);
assert.deepEqual(legacyOff({ remove: ["phone_screen", "sandbox", "web"] }).sort(), ["computer_shell", "phone_as_user", "web"]);
assert.deepEqual(legacyOff({ remove: ["coding-tools"] }).sort(), ["computer_shell", "files"]);

const all = { has: () => true, implements: () => true };
const owners = new Map<string, Groups>([
	["weather", ["weather"]],
	["find_places", ["places"]],
	["bash", ["files", "computer_shell"]],
	["run_command", ["computer_agents"]],
	["codemode", "always"],
]);
assert.deepEqual(removedTools(owners, [], "phone", all), ["run_command"]);
assert.deepEqual(removedTools(owners, ["places"], "phone", all), ["find_places", "run_command"]);
assert.deepEqual(removedTools(owners, ["files"], "phone", all), ["bash", "run_command"]);
assert.deepEqual(removedTools(owners, ["files"], "computer", all), []);
assert.deepEqual(removedTools(owners, ["computer_shell"], "computer", all), ["bash"]);
assert.deepEqual(removedTools(owners, [], "missing", all), ["bash", "run_command"]);
assert.deepEqual(removedTools(owners, [], "phone", { has: (plugin) => plugin !== "BotFiles", implements: () => true }), ["bash", "run_command"]);
assert.deepEqual(removedTools(owners, ["no_longer_a_group"], "phone", all), ["run_command"]);
console.log("toolsets: old extension choices become toolset choices, and a bot's toolsets and place decide its tools, whatever extension holds them");
