import { readdirSync, readFileSync } from "node:fs";
import { parseSync } from "rolldown/utils";

type Node = { type: string; [key: string]: unknown };
const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";

const runtime = new URL("../src/agent/runtime.ts", import.meta.url);
const program = parseSync("runtime.ts", readFileSync(runtime, "utf8")).program;
const declared: unknown[] = program.body.map((node) => (isNode(node) && isNode(node.declaration) ? node.declaration : node));
const runtimeClass = declared.find((node) => isNode(node) && node.type === "ClassDeclaration" && isNode(node.id) && node.id.name === "AgentRuntime");
const body = isNode(runtimeClass) && isNode(runtimeClass.body) && Array.isArray(runtimeClass.body.body) ? runtimeClass.body.body : [];
const members = new Set(body.flatMap((member) => (isNode(member) && isNode(member.key) && member.key.type === "Identifier" ? [String(member.key.name)] : [])));

const DIRECTORIES = ["test/device", "test/perf", "test/bash", ".pi/skills/device-testing", ".pi/skills/device-testing/scripts"];
const USE = /\b(?:piRuntime|rt)\.(\w+)/g;
const unknown = DIRECTORIES.flatMap((directory) =>
	readdirSync(new URL(`../${directory}/`, import.meta.url), { withFileTypes: true })
		.filter((entry) => entry.isFile())
		.flatMap((entry) => {
			const file = `${directory}/${entry.name}`;
			const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
			return [...source.matchAll(USE)].map((match) => match[1] ?? "").filter((name) => !members.has(name)).map((name) => `${file}: ${name}`);
		}),
);
if (members.size === 0 || unknown.length > 0) {
	console.error(`device-api: scripts call window.piRuntime members that AgentRuntime (src/agent/runtime.ts) does not have; rename them with the runtime: ${[...new Set(unknown)].join(", ") || "AgentRuntime not found"}`);
	process.exit(1);
}
console.log(`device-api: device and perf scripts call only the ${members.size} members AgentRuntime has`);
