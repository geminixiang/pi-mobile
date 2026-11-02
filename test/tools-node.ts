import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseSync } from "rolldown/utils";
import { defineExtension, type ToolRegistration } from "@earendil-works/pi-durable";
import { builtinExtensions } from "../src/agent/catalog.ts";
import { DEFAULT_CALENDAR_ACCESS } from "../src/agent/calendar-access.ts";
import type { PairedHost } from "../src/agent/sandbox/host.ts";
import type { Sandbox } from "../src/agent/sandbox/sandbox.ts";
import type { Workplace } from "../src/agent/workplaces.ts";
import { azureService, cloudflareService, googleService } from "../src/agent/tools/cloud.ts";
import { TOOLSETS } from "../src/agent/toolsets.ts";
import { declarationOf, type Effect } from "../src/agent/tools/common.ts";
import { exitOnFailures, plain, snapshotFailures, sourcesMatching, updating } from "./snapshot.ts";

const SNAPSHOT = new URL("./tools.snapshot.json", import.meta.url);

const unused = () => Promise.reject(new Error("not in the interface check"));
const sandbox: Sandbox = {
	direct: false,
	status: { kind: "idle" },
	subscribe: () => () => undefined,
	root: (folder) => folder,
	env: unused,
	exists: unused,
	remove: unused,
	describe: () => "",
	close: () => undefined,
};
const host: PairedHost = { id: "fixture", address: "fixture", name: "fixture", os: "linux", arch: "arm64", user: "fixture", home: "/home/fixture", key: "fixture" };
const workplace: Workplace = { kind: "computer", folder: "fixture", computer: { key: "fixture:container", name: "fixture", mode: "容器" }, host, sandbox, root: "fixture", env: unused };

const { extensions } = builtinExtensions({
	native: { has: () => true, implements: () => true },
	assistant: defineExtension({ name: "assistant" }),
	calendarAccess: DEFAULT_CALENDAR_ACCESS,
	githubToken: "token",
	clouds: [googleService(async () => "", undefined), cloudflareService(async () => "", undefined), azureService(async () => "", undefined)],
	web: { baseUrl: "", apiKey: "", modelIds: [] },
	triggers: { changed: () => undefined, unattended: () => false, notify: async () => "shown" },
	memory: { changed: () => undefined },
	workplace: () => workplace,
	labelOf: (name) => name,
	actsAsUser: async () => false,
});

interface ToolInterface {
	extension: string;
	toolset: string;
	name: string;
	deferred: boolean;
	callers: readonly string[];
	parameters: unknown;
	structuredOutput: unknown;
	effect: Effect | null;
	needs: string[];
}

const toolsetOf = (extension: string) => TOOLSETS.find((toolset) => toolset.extensions.includes(extension))?.id ?? "fixed";

function interfaceOf(extension: string, tool: ToolRegistration): ToolInterface {
	return {
		extension,
		toolset: toolsetOf(extension),
		name: tool.name,
		deferred: tool.deferred === true,
		callers: tool.callers ?? ["model", "tools"],
		parameters: plain(tool.parameters),
		structuredOutput: tool.structuredOutputSchema ? plain(tool.structuredOutputSchema) : null,
		effect: declarationOf(tool)?.effect ?? null,
		needs: (declarationOf(tool)?.needs ?? []).map(({ plugin, method }) => `${plugin}.${method}`),
	};
}

const tools = extensions.flatMap((extension) => (extension.tools ?? []).map((tool) => ({ tool, iface: interfaceOf(extension.name, tool) })));

const EXTERNAL = new Set(["coding-tools", "codemode", "tool-search"]);

const docs = readFileSync(new URL("../docs/tools.md", import.meta.url), "utf8");
const toolListSection = docs.slice(docs.indexOf("## 工具清單"), docs.indexOf("\n## ", docs.indexOf("## 工具清單")));
const listed = new Map(
	toolListSection
		.split("\n")
		.filter((line) => line.startsWith("| `"))
		.flatMap((line) => {
			const [, names = "", , , change = "", structured = ""] = line.split("|");
			return [...names.matchAll(/`([^`]+)`/g)].flatMap((match) => (match[1] ? [[match[1], { change, structured: structured.includes("✓") }] as const] : []));
		}),
);

const CHANGE_WORDS: Record<Effect, { says: string; not: string[] }> = {
	read: { says: "唯讀", not: ["直接", "開畫面"] },
	screen: { says: "開畫面", not: ["直接"] },
	direct: { says: "直接", not: [] },
};

type Rule = { rule: string; broken: (entry: (typeof tools)[number]) => string | undefined };
const NAME = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const UNIT = /_(ms|seconds|minutes|hours|days|m|km|kg)$/;
const DURATION_WORDS = /^(seconds|minutes|hours|days)$/;

function fieldNames(schema: unknown): string[] {
	if (typeof schema !== "object" || schema === null) return [];
	const names: string[] = [];
	for (const [key, inner] of properties(schema)) names.push(key, ...fieldNames(inner));
	for (const nested of ["items", "additionalProperties"]) names.push(...fieldNames(Reflect.get(schema, nested)));
	const anyOf: unknown = Reflect.get(schema, "anyOf");
	if (Array.isArray(anyOf)) for (const option of anyOf) names.push(...fieldNames(option));
	return [...new Set(names)];
}

function properties(schema: unknown): [string, Record<string, unknown>][] {
	if (typeof schema !== "object" || schema === null) return [];
	const props = Reflect.get(schema, "properties");
	if (typeof props !== "object" || props === null) return [];
	return Object.entries(props).flatMap(([key, value]) => (typeof value === "object" && value !== null ? [[key, Object.fromEntries(Object.entries(value))]] : []));
}

const rules: Rule[] = [
	{
		rule: "app tools are defined with defineAppTool (src/agent/tools/common.ts), which cleans empty optional arguments and declares reach, effect and needs",
		broken: ({ tool, iface }) => (declarationOf(tool) ? undefined : `${iface.name} (${iface.extension})`),
	},
	{
		rule: "the 改動 column of docs/tools.md says the tool's declared effect",
		broken: ({ iface }) => {
			const words = iface.effect ? CHANGE_WORDS[iface.effect] : undefined;
			const change = listed.get(iface.name)?.change ?? "";
			return words && (!change.includes(words.says) || words.not.some((word) => change.includes(word))) ? `${iface.name} (${iface.effect})` : undefined;
		},
	},
	{
		rule: "a tool has a structuredOutputSchema exactly when docs/tools.md marks it 結構化",
		broken: ({ iface }) => (Boolean(iface.structuredOutput) === (listed.get(iface.name)?.structured ?? false) ? undefined : iface.name),
	},
	{
		rule: "structured output fields are snake_case",
		broken: ({ iface }) => fieldNames(iface.structuredOutput).filter((key) => !NAME.test(key)).map((key) => `${iface.name}.${key}`).join(", ") || undefined,
	},
	{
		rule: "every tool is in the tool list of docs/tools.md",
		broken: ({ iface }) => (listed.has(iface.name) ? undefined : iface.name),
	},
	{ rule: "tool names are snake_case", broken: ({ iface }) => (NAME.test(iface.name) ? undefined : iface.name) },
	{
		rule: "descriptions say what the tool does in at least one sentence",
		broken: ({ tool, iface }) => ((tool.description ?? "").trim().length >= 40 ? undefined : iface.name),
	},
	{
		rule: "parameters are an object schema",
		broken: ({ iface }) => (typeof iface.parameters === "object" && iface.parameters !== null && Reflect.get(iface.parameters, "type") === "object" ? undefined : iface.name),
	},
	{
		rule: "parameter names are snake_case",
		broken: ({ iface }) => properties(iface.parameters).map(([key]) => key).filter((key) => !NAME.test(key)).map((key) => `${iface.name}.${key}`).join(", ") || undefined,
	},
	{
		rule: "every parameter has a description, or is an enum of self-explanatory literals",
		broken: ({ iface }) =>
			properties(iface.parameters)
				.filter(([, schema]) => typeof schema.description !== "string" && !Array.isArray(schema.anyOf) && !Array.isArray(schema.enum) && schema.const === undefined && schema.type !== "object" && schema.type !== "array")
				.map(([key]) => `${iface.name}.${key}`)
				.join(", ") || undefined,
	},
	{
		rule: "numbers with a unit say it in the name (_minutes, _hours, _days, _m, _km) or are named for it (hours, days)",
		broken: ({ iface }) =>
			properties(iface.parameters)
				.filter(([key, schema]) => (schema.type === "number" || schema.type === "integer") && /(radius|delay|duration|timeout|interval|distance|gap|every)/.test(key) && !UNIT.test(key) && !DURATION_WORDS.test(key))
				.map(([key]) => `${iface.name}.${key}`)
				.join(", ") || undefined,
	},
	{
		rule: "a tool that acts as the user is named *_as_user, loads on demand, and is the only kind in a *_as_user extension",
		broken: ({ iface }) =>
			iface.name.endsWith("_as_user") === iface.extension.endsWith("_as_user") && (!iface.name.endsWith("_as_user") || iface.deferred) ? undefined : `${iface.name} (${iface.extension})`,
	},
	{
		rule: "tools are in a toolset, or fixed on and listed as such in toolsets.ts",
		broken: ({ iface }) => (iface.toolset !== "fixed" || FIXED.has(iface.extension) ? undefined : `${iface.name} (${iface.extension})`),
	},
];

const FIXED = new Set(["bot", "skills", "attachments", "schedules", "memory", "items", "tool-search", "on-demand", "assistant", "computer_shell"]);

const failures: string[] = [];
const names = new Map<string, string>();
for (const { iface } of tools) {
	const other = names.get(iface.name);
	if (other) failures.push(`tool ${iface.name} is defined twice (${other}, ${iface.extension})`);
	names.set(iface.name, iface.extension);
}
for (const { rule, broken } of rules) {
	const offenders = tools
		.filter(({ iface }) => !EXTERNAL.has(iface.extension) || rule.startsWith("every tool is"))
		.map(broken)
		.filter((value): value is string => Boolean(value));
	if (offenders.length) failures.push(`${rule}: ${offenders.join("; ")}`);
}
const reexported = sourcesMatching(/import \{[^}]*\bType\b[^}]*\} from "@earendil-works\/pi-ai"/);
if (reexported.length) failures.push(`schemas use Type from "typebox", not from @earendil-works/pi-ai: ${reexported.join(", ")}`);

const current = tools.map(({ iface }) => iface);
failures.push(...snapshotFailures(SNAPSHOT, current, "tool", "its interface"));

type Node = { type: string; [key: string]: unknown };
const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
const nodesIn = (node: unknown): Node[] => (isNode(node) ? [node, ...Object.values(node).flatMap((value) => (Array.isArray(value) ? value : [value])).flatMap(nodesIn)] : []);
const isName = (node: unknown) => isNode(node) && ((node.type === "Identifier" && node.name === "name") || (node.type === "MemberExpression" && isNode(node.property) && node.property.name === "name"));
const stringOf = (node: unknown) => (isNode(node) && node.type === "Literal" && typeof node.value === "string" ? [node.value] : []);
function toolNamesIn(node: Node): string[] {
	if (node.type === "BinaryExpression" && node.operator === "===") return isName(node.left) ? stringOf(node.right) : isName(node.right) ? stringOf(node.left) : [];
	if (node.type === "VariableDeclarator" && isNode(node.id) && String(node.id.name).endsWith("_TOOLS") && isNode(node.init) && Array.isArray(node.init.arguments)) {
		const list = node.init.arguments[0];
		return isNode(list) && Array.isArray(list.elements) ? list.elements.flatMap(stringOf) : [];
	}
	return [];
}
const APP = new URL("../src/app/", import.meta.url);
const toolNames = new Set(current.map((tool) => tool.name));
for (const file of readdirSync(APP).filter((name) => /\.tsx?$/.test(name))) {
	const missing = nodesIn(parseSync(file, readFileSync(new URL(file, APP), "utf8")).program).flatMap(toolNamesIn).filter((name) => !toolNames.has(name));
	if (missing.length) failures.push(`src/app/${file} names tools that do not exist (renamed or deleted? rename them here too): ${[...new Set(missing)].join(", ")}`);
}

const MAP_START = "<!-- 工具總圖：node --import ./test/vite-imports.js test/tools-node.ts --update 產生，不要手改 -->";
const MAP_END = "<!-- 工具總圖結束 -->";
const shown = (tool: ToolInterface) => `\`${tool.name}\`${tool.deferred ? "＊" : tool.callers.includes("model") ? "†" : ""}`;
const toolsOf = (extension: string) => current.filter((tool) => tool.extension === extension).map(shown).join("、") || "沒有自己的工具";
const switched = new Set(TOOLSETS.flatMap((toolset) => toolset.extensions));
const map = [
	MAP_START,
	"",
	"每個開關（工具組）底下是它的擴充，擴充後面是它的工具。＊需要時載入，†直接提供，其他只給腳本。不含 MCP 服務。",
	"",
	...TOOLSETS.flatMap((toolset) => [`- **${toolset.label}**（\`${toolset.id}\`）`, ...toolset.extensions.map((extension) => `  - \`${extension}\`：${toolsOf(extension)}`)]),
	"- **固定開著**（沒有開關）",
	...[...new Set(current.map((tool) => tool.extension))].filter((extension) => !switched.has(extension)).map((extension) => `  - \`${extension}\`：${toolsOf(extension)}`),
	"",
	MAP_END,
].join("\n");
const mapAt = docs.indexOf(MAP_START);
const mapEnd = docs.indexOf(MAP_END);
if (mapAt < 0 || mapEnd < mapAt) failures.push("docs/tools.md has no 工具總圖 between its two markers");
else if (updating) writeFileSync(new URL("../docs/tools.md", import.meta.url), docs.slice(0, mapAt) + map + docs.slice(mapEnd + MAP_END.length));
else if (docs.slice(mapAt, mapEnd + MAP_END.length) !== map) failures.push("docs/tools.md 工具總圖 is out of date: run with --update");
exitOnFailures(failures);
console.log(`tools: ${current.length} tools in ${new Set(current.map((tool) => tool.extension)).size} extensions follow the interface${updating ? " (snapshot updated)" : " and match the snapshot"}`);
