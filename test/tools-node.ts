import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { defineExtension, type ToolRegistration } from "@earendil-works/pi-durable";
import { builtinExtensions } from "../src/agent/catalog.ts";
import { DEFAULT_CALENDAR_ACCESS } from "../src/agent/calendar-access.ts";
import type { PairedHost } from "../src/agent/sandbox/host.ts";
import type { Sandbox } from "../src/agent/sandbox/sandbox.ts";
import type { Workplace } from "../src/agent/workplaces.ts";
import { azureService, cloudflareService, googleService } from "../src/agent/tools/cloud.ts";
import { TOOLSETS } from "../src/agent/toolsets.ts";
import { NATIVE_PLUGINS } from "../src/native.ts";

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

const extensions = builtinExtensions({
	native: new Set(NATIVE_PLUGINS),
	assistant: defineExtension({ name: "assistant" }),
	calendarAccess: DEFAULT_CALENDAR_ACCESS,
	githubToken: "token",
	clouds: [googleService(async () => "", undefined), cloudflareService(async () => "", undefined), azureService(async () => "", undefined)],
	web: { baseUrl: "", apiKey: "", modelIds: [] },
	triggers: { changed: () => undefined, notify: async () => false },
	memory: { changed: () => undefined },
	workplace: () => workplace,
	labelOf: (name) => name,
});

interface ToolInterface {
	extension: string;
	toolset: string;
	name: string;
	deferred: boolean;
	callers: readonly string[];
	parameters: unknown;
	structuredOutput: unknown;
}

function plain(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(plain);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([, inner]) => typeof inner !== "function")
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, inner]) => [key, plain(inner)]),
	);
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
	};
}

const tools = extensions.flatMap((extension) => (extension.tools ?? []).map((tool) => ({ tool, iface: interfaceOf(extension.name, tool) })));

const EXTERNAL = new Set(["coding-tools", "codemode", "tool-search"]);

const RECORDS = new Set([
	"weather", "find_places", "sql", "read_notifications", "contacts", "find_photos", "call_log", "read_sms", "screen_time",
	"health", "read_calendar_events", "github_api", "gcp_api", "cloudflare_api", "azure_api",
]);

const docs = readFileSync(new URL("../docs/tools.md", import.meta.url), "utf8");
const toolListSection = docs.slice(docs.indexOf("## 工具清單"), docs.indexOf("\n## ", docs.indexOf("## 工具清單")));
const listedTools = new Set(
	toolListSection
		.split("\n")
		.filter((line) => line.startsWith("| "))
		.flatMap((line) => [...(line.split("|")[1] ?? "").matchAll(/`([^`]+)`/g)].map((match) => match[1])),
);

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
		rule: "app tools are defined with defineAppTool (src/agent/tools/common.ts), which cleans empty optional arguments",
		broken: ({ tool, iface }) => (EXTERNAL.has(iface.extension) || tool.prepareArguments ? undefined : `${iface.name} (${iface.extension})`),
	},
	{
		rule: "tools that return records have a structuredOutputSchema",
		broken: ({ iface }) => (RECORDS.has(iface.name) && !iface.structuredOutput ? iface.name : undefined),
	},
	{
		rule: "structured output fields are snake_case",
		broken: ({ iface }) => fieldNames(iface.structuredOutput).filter((key) => !NAME.test(key)).map((key) => `${iface.name}.${key}`).join(", ") || undefined,
	},
	{
		rule: "every tool is in the tool list of docs/tools.md",
		broken: ({ iface }) => (listedTools.has(iface.name) ? undefined : iface.name),
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
				.filter(([, schema]) => typeof schema.description !== "string" && !Array.isArray(schema.anyOf) && schema.const === undefined && schema.type !== "object" && schema.type !== "array")
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
		rule: "tools are in a toolset, or fixed on and listed as such in toolsets.ts",
		broken: ({ iface }) => (iface.toolset !== "fixed" || FIXED.has(iface.extension) ? undefined : `${iface.name} (${iface.extension})`),
	},
];

const FIXED = new Set(["bot", "skills", "attachments", "triggers", "memory", "tool-search", "on-demand", "assistant", "sandbox"]);

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
const sources = readdirSync(new URL("../src", import.meta.url), { recursive: true, encoding: "utf8" }).filter((file) => /\.tsx?$/.test(file));
const reexported = sources.filter((file) => /import \{[^}]*\bType\b[^}]*\} from "@earendil-works\/pi-ai"/.test(readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8")));
if (reexported.length) failures.push(`schemas use Type from "typebox", not from @earendil-works/pi-ai: ${reexported.join(", ")}`);

const current = tools.map(({ iface }) => iface);
const update = process.argv.includes("--update");
if (update) {
	writeFileSync(SNAPSHOT, `${JSON.stringify(current, null, "\t")}\n`);
	console.log(`tools.snapshot.json: ${current.length} tools`);
} else {
	let saved: ToolInterface[] = [];
	try {
		saved = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
	} catch {
		failures.push("no test/tools.snapshot.json; run with --update to create it");
	}
	const byName = new Map(saved.map((tool) => [tool.name, tool]));
	for (const tool of current) {
		const before = byName.get(tool.name);
		if (!before) failures.push(`new tool ${tool.name}: add it to the snapshot (--update) and to docs/tools.md`);
		else if (JSON.stringify(before) !== JSON.stringify(tool)) failures.push(`${tool.name} changed its interface; if intended, --update and note it in docs/tools.md`);
		byName.delete(tool.name);
	}
	for (const name of byName.keys()) failures.push(`tool ${name} is gone; if intended, --update and note it in docs/tools.md`);
}

if (failures.length) {
	console.error(failures.map((failure) => `✖ ${failure}`).join("\n"));
	process.exit(1);
}
console.log(`tools: ${current.length} tools in ${new Set(current.map((tool) => tool.extension)).size} extensions follow the interface${update ? "" : " and match the snapshot"}`);
