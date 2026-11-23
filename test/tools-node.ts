import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseSync } from "rolldown/utils";
import { defineExtension, type ToolRegistration } from "@earendil-works/pi-durable";
import { builtinExtensions } from "../src/runtime/catalog.ts";
import { DEFAULT_CALENDAR_ACCESS } from "../src/agent/calendar-access.ts";
import type { PairedHost } from "../src/computer/pairing.ts";
import type { Sandbox } from "../src/agent/sandbox/sandbox.ts";
import type { Workplace } from "../src/agent/workplaces.ts";
import { azureService, cloudflareService, googleService } from "../src/clouds/tool.ts";
import { TOOLSETS } from "../src/agent/toolsets.ts";
import { NATIVE_PLUGINS } from "../src/native.ts";
import { declarationOf, type Effect } from "../src/agent/tools/common.ts";
import { checkedFiles, inSource } from "./no-comments.ts";
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
	userSaid: async () => [],
	assistant: defineExtension({ name: "assistant" }),
	calendarAccess: DEFAULT_CALENDAR_ACCESS,
	githubToken: "token",
	clouds: [googleService(async () => "", undefined), cloudflareService(async () => "", undefined), azureService(async () => "", undefined)],
	web: { baseUrl: "", apiKey: "", modelIds: [] },
	triggers: { changed: () => undefined, unattended: () => false, notify: async () => "shown" },
	memory: { changed: () => undefined },
	skills: { changed: () => undefined },
	workplace: () => workplace,
	waitForJob: () => undefined,
	labelOf: (tool) => tool,
	actsAsUser: async () => false,
	platform: { native: { has: () => true, implements: () => true }, permissions: { state: async () => "granted", request: async () => true }, apps: { installed: async () => [] } },
	ask: async () => ({ action: "cancel" }),
});

interface ToolInterface {
	extension: string;
	groups: readonly string[] | "always" | null;
	name: string;
	description_chars: number;
	deferred: boolean;
	callers: readonly string[];
	parameters: unknown;
	structuredOutput: unknown;
	effect: Effect | null;
	needs: string[];
	outside: string | null;
	sends: boolean;
	loads?: readonly string[];
}

function interfaceOf(extension: string, tool: ToolRegistration): ToolInterface {
	return {
		extension,
		groups: declarationOf(tool)?.groups ?? null,
		name: tool.name,
		description_chars: (tool.description ?? "").length,
		deferred: tool.deferred === true,
		callers: tool.callers ?? ["model", "tools"],
		parameters: plain(tool.parameters),
		structuredOutput: tool.structuredOutputSchema ? plain(tool.structuredOutputSchema) : null,
		effect: declarationOf(tool)?.effect ?? null,
		needs: (declarationOf(tool)?.needs ?? []).map(({ plugin, method }) => `${plugin}.${method}`),
		outside: declarationOf(tool)?.outside ?? null,
		sends: declarationOf(tool)?.sends === true,
		...(declarationOf(tool)?.loads ? { loads: declarationOf(tool)?.loads } : {}),
	};
}

const tools = extensions.flatMap((extension) => (extension.tools ?? []).map((tool) => ({ tool, iface: interfaceOf(extension.name, tool) })));

const TOOL_CHARS: Record<string, number> = {
	device_info: 294,
	get_location: 221,
	read_sensors: 384,
	get_travel_time: 611,
	weather: 729,
	find_places: 1146,
	tw_stocks: 1400,
	sql: 699,
	set_alarm: 427,
	open_alarms: 222,
	set_timer: 279,
	compose_email: 370,
	compose_sms: 289,
	open_maps: 444,
	open_link: 288,
	share: 472,
	speak: 548,
	read_notifications: 900,
	reply_notification: 570,
	dismiss_notifications: 325,
	phone_read_as_user: 643,
	phone_act_as_user: 2232,
	phone_open_as_user: 287,
	phone_note_as_user: 550,
	read_page: 651,
	use_browser: 3275,
	media: 422,
	do_not_disturb: 483,
	sound: 650,
	display: 627,
	flashlight: 257,
	connections: 588,
	contacts: 512,
	find_photos: 855,
	view_photos: 311,
	call_log: 325,
	read_sms: 522,
	screen_time: 381,
	health: 571,
	read_skill: 265,
	save_skill: 812,
	read_attachment: 935,
	scan_document: 429,
	read_calendar_events: 768,
	list_calendars: 254,
	add_calendar_event: 812,
	delete_calendar_event: 616,
	codemode: 1717,
	github_api: 557,
	github_read_file: 463,
	gcp_api: 589,
	cloudflare_api: 541,
	azure_api: 561,
	web_search: 404,
	web_fetch: 776,
	create_schedule: 4045,
	schedule_followup: 610,
	list_schedules: 87,
	delete_schedule: 164,
	notify: 465,
	note_item: 1363,
	list_items: 315,
	update_memory: 640,
	ask_user: 1164,
	computer_read_as_user: 1218,
	computer_act_as_user: 2324,
	list_agents: 557,
	read_agent: 540,
	tell_agent: 760,
	answer_agent: 827,
	read: 602,
	write: 352,
	edit: 1102,
	bash: 810,
	tool_search: 448,
};

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
		rule: "every tool is declared with its groups: app tools with defineAppTool (src/agent/tools/common.ts), which also cleans empty optional arguments and declares reach, effect and needs; tools from a library with adopt in src/runtime/catalog.ts",
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
		rule: "a tool that needs a native method that opens a screen (opens: \"screen\" in src/plugins/) declares effect: \"screen\", so the catalog checks pi may open one first",
		broken: ({ tool, iface }) => ((declarationOf(tool)?.needs ?? []).some((method) => method.opens === "screen") && iface.effect !== "screen" ? iface.name : undefined),
	},
	{
		rule: "a tool that acts as the user is named *_as_user, is the only kind in a *_as_user toolset, and loads on demand, except an entry tool whose loads (defineAppTool) names every other tool of its toolset",
		broken: ({ iface }) => {
			const asUser = Array.isArray(iface.groups) && iface.groups.every((group) => group.endsWith("_as_user"));
			const others = tools.filter(({ iface: other }) => other.name !== iface.name && JSON.stringify(other.groups) === JSON.stringify(iface.groups)).map(({ iface: other }) => other.name);
			const entry = others.length > 0 && others.every((name) => iface.loads?.includes(name));
			return iface.name.endsWith("_as_user") === asUser && (!asUser || iface.deferred || entry) ? undefined : `${iface.name} (${String(iface.groups)})`;
		},
	},
	{
		rule: "a tool's loads (defineAppTool) names tools that exist",
		broken: ({ iface }) => (iface.loads ?? []).filter((name) => !tools.some(({ iface: other }) => other.name === name)).map((name) => `${iface.name} loads ${name}`).join(", ") || undefined,
	},
	{
		rule: "every tool is in groups whose where differ when it has several, so one toolset decides it wherever the bot works",
		broken: ({ iface }) => {
			if (!Array.isArray(iface.groups) || iface.groups.length < 2) return undefined;
			const wheres = iface.groups.map((group) => TOOLSETS.find((toolset) => toolset.id === group)?.where);
			return wheres.every((where) => where !== undefined) && new Set(wheres).size === wheres.length ? undefined : `${iface.name} (${iface.groups.join(", ")})`;
		},
	},
];


const failures: string[] = [];
const names = new Map<string, string>();
for (const { tool, iface } of tools) {
	const chars = iface.description_chars + JSON.stringify(tool.parameters).length;
	const allowed = TOOL_CHARS[iface.name];
	if (allowed === undefined || chars > allowed) failures.push(`${iface.name} is ${chars} characters, ${allowed ?? "no baseline"} allowed (TOOL_CHARS): shorten it or move grammar into the schema; raise it only with a measured row in docs/tools.md`);
	if (allowed !== undefined && chars < allowed) failures.push(`${iface.name} is ${chars} characters, fewer than TOOL_CHARS (${allowed}): lower it to ${chars} so the ratchet holds`);
	const other = names.get(iface.name);
	if (other) failures.push(`tool ${iface.name} is defined twice (${other}, ${iface.extension})`);
	names.set(iface.name, iface.extension);
}
for (const name of Object.keys(TOOL_CHARS)) {
	if (!names.has(name)) failures.push(`${name} no longer exists: remove its TOOL_CHARS entry so the ratchet holds`);
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
const isToolList = (node: unknown) => isNode(node) && node.type === "Identifier" && /TOOL/.test(String(node.name));
function toolNamesIn(node: Node): string[] {
	if (node.type === "BinaryExpression" && node.operator === "===") return isName(node.left) ? stringOf(node.right) : isName(node.right) ? stringOf(node.left) : [];
	if (node.type === "SwitchStatement" && isName(node.discriminant) && Array.isArray(node.cases)) return node.cases.flatMap((branch) => (isNode(branch) ? stringOf(branch.test) : []));
	if (node.type === "CallExpression" && isNode(node.callee) && node.callee.type === "MemberExpression" && isNode(node.callee.property) && node.callee.property.name === "includes" && Array.isArray(node.arguments) && isName(node.arguments[0])) {
		const list = node.callee.object;
		return isNode(list) && Array.isArray(list.elements) ? list.elements.flatMap(stringOf) : [];
	}
	if (node.type === "VariableDeclarator" && isToolList(node.id) && isNode(node.init) && Array.isArray(node.init.arguments)) {
		const list = node.init.arguments[0];
		if (!isNode(list) || !Array.isArray(list.elements)) return [];
		return list.elements.flatMap((element) => (isNode(element) && Array.isArray(element.elements) ? stringOf(element.elements[0]) : stringOf(element)));
	}
	return [];
}
const SRC = new URL("../src/", import.meta.url);
const pluginNames = NATIVE_PLUGINS.join("|");
const CALL = new RegExp(`\\b(${pluginNames})\\.(\\w+)\\(`, "g");
const NEEDS = /needs:\s*\[([^\]]*)\]/g;
const GUARD = /native\.implements\(\s*(\w+\.\w+)\s*\)/g;
const QUALIFIED = /\b(\w+\.\w+)\b/g;
for (const file of readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".ts"))) {
	const source = readFileSync(new URL(file, SRC), "utf8");
	if (!source.includes("defineAppTool(")) continue;
	const declared = new Set([...source.matchAll(NEEDS)].flatMap((match) => [...(match[1] ?? "").matchAll(QUALIFIED)].map((name) => name[1] ?? "")));
	const guarded = new Set([...source.matchAll(GUARD)].map((match) => match[1] ?? ""));
	const loose = [...new Set([...source.matchAll(CALL)].map((match) => `${match[1]}.${match[2]}`))].filter((call) => !call.endsWith(".addListener") && !declared.has(call) && !guarded.has(call));
	if (loose.length) failures.push(`src/${file} calls native methods its tools neither need nor check: ${loose.join(", ")}; add each to the tool's needs, or check native.implements(…) before an optional call`);
}

const uiFiles = checkedFiles().filter((file) => inSource(file) && (file.endsWith(".tsx") || (file.startsWith("src/app/") && file.endsWith(".ts"))));
const toolNames = new Set(current.map((tool) => tool.name));
for (const file of uiFiles) {
	const missing = nodesIn(parseSync(file, readFileSync(file, "utf8")).program).flatMap(toolNamesIn).filter((name) => !toolNames.has(name));
	if (missing.length) failures.push(`${file} names tools that do not exist (renamed or deleted? rename them here too): ${[...new Set(missing)].join(", ")}`);
}

const MAP_START = "<!-- 工具總圖：node --import ./test/vite-imports.js test/tools-node.ts --update 產生，不要手改 -->";
const MAP_END = "<!-- 工具總圖結束 -->";
const shown = (tool: ToolInterface) => `\`${tool.name}\`${tool.deferred ? "＊" : tool.callers.includes("model") ? "†" : ""}`;
const toolsIn = (id: string) => current.filter((tool) => Array.isArray(tool.groups) && tool.groups.includes(id)).map(shown).join("、");
const map = [
	MAP_START,
	"",
	"每個開關（工具組）後面是它的工具，由工具自己宣告的 groups 決定，和擴充無關。＊需要時載入，†直接提供，其他只給腳本。不含 MCP 服務。",
	"",
	...TOOLSETS.map((toolset) => `- **${toolset.label}**（\`${toolset.id}\`）：${toolsIn(toolset.id)}`),
	`- **固定開著**（沒有開關）：${current.filter((tool) => tool.groups === "always").map(shown).join("、")}`,
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
