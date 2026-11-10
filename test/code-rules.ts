import { readFileSync } from "node:fs";
import { parseSync } from "rolldown/utils";
import { checkedFiles } from "./no-comments.ts";

type Node = { type: string; start: number; [key: string]: unknown };
type Finding = { file: string; line: number; rule: string };

const SCRIPT_FILE = /\.(ts|tsx)$/;
const DEVICE_SCRIPTS = /^test\/(device|perf)\//;
const WHY_LINE = /^\s*\/\/ why: \S/;

function isNode(value: unknown): value is Node {
	return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

function children(node: Node): Node[] {
	return Object.values(node).flatMap((value) => (Array.isArray(value) ? value.filter(isNode) : isNode(value) ? [value] : []));
}

function isConstAssertion(node: Node): boolean {
	const annotation = node.typeAnnotation;
	return isNode(annotation) && annotation.type === "TSTypeReference" && isNode(annotation.typeName) && annotation.typeName.name === "const";
}

function returnsNothing(callback: unknown): boolean {
	if (!isNode(callback) || callback.type !== "ArrowFunctionExpression") return false;
	const body = callback.body;
	if (!isNode(body)) return false;
	if (body.type === "Identifier") return body.name === "undefined";
	return body.type === "BlockStatement" && Array.isArray(body.body) && body.body.length === 0;
}

function isSwallowingCatch(node: Node): boolean {
	const callee = node.callee;
	if (!isNode(callee) || callee.type !== "MemberExpression") return false;
	const property = callee.property;
	return isNode(property) && property.name === "catch" && Array.isArray(node.arguments) && returnsNothing(node.arguments[0]);
}

function isInlineStyle(node: Node): boolean {
	if (node.type !== "JSXAttribute" || !isNode(node.name) || node.name.name !== "style" || !isNode(node.value)) return false;
	const object = node.value.expression;
	if (!isNode(object) || object.type !== "ObjectExpression" || !Array.isArray(object.properties)) return false;
	return object.properties.some((property) => {
		if (!isNode(property) || !isNode(property.key)) return true;
		const key = property.key.type === "Identifier" ? property.key.name : property.key.value;
		return typeof key !== "string" || !key.startsWith("--");
	});
}

function rule(node: Node, explained: boolean): string | undefined {
	if (node.type === "TSAsExpression" && !isConstAssertion(node) && !explained) return "as cast without a why: line above it";
	if (node.type === "TSTypeAssertion") return "<T> cast";
	if (node.type === "TSNonNullExpression") return "non-null assertion";
	if (node.type === "TSAnyKeyword") return "any";
	if (node.type === "CallExpression" && isSwallowingCatch(node)) return "catch that swallows the error";
	if (isInlineStyle(node)) return "inline style other than a custom property: put it in styles.css, or pass a --custom-property the stylesheet reads (CSS skill)";
	return undefined;
}

function findings(file: string): Finding[] {
	const source = readFileSync(file, "utf8");
	const lines = source.split("\n");
	const lineOf = (offset: number) => source.slice(0, offset).split("\n").length;
	const found: Finding[] = [];
	const visit = (node: unknown) => {
		if (!isNode(node)) return;
		const broken = rule(node, WHY_LINE.test(lines[lineOf(node.start) - 2] ?? ""));
		if (broken) found.push({ file, line: lineOf(node.start), rule: broken });
		children(node).forEach(visit);
	};
	visit(parseSync(file, source).program);
	return found;
}

const SOURCE_FILE = /\.(ts|tsx|java|kt|swift)$/;
const OWNED: { use: RegExp; owners: readonly string[]; fix: string }[] = [
	{
		use: /\bnew WebView\(|[=(] *WebView\(/,
		owners: ["WebPages.kt"],
		fix: "a WebView on pi's profile shares pi's renderer, so a third-party page can freeze pi: create it with WebPages.create(context, profile)",
	},
	{
		use: /PhoneScreenService\.(?!canStartActivities\b)\w+/,
		owners: ["PhoneScreenService.kt", "PhoneScreenPlugin.kt", "ScreenActor.kt", "ScreenElements.kt"],
		fix: "only the phone screen code reaches the accessibility service; ask PhoneScreenService.canStartActivities(activity) whether a screen may open",
	},
	{
		use: /\bopenScreen\(/,
		owners: ["src/agent/catalog.ts", "src/agent/tools/apps.ts"],
		fix: "declare effect: \"screen\" and the catalog checks whether pi may open a screen before the tool runs; a tool does not call openScreen itself",
	},
	{
		use: /\bTriggerDoc\b/,
		owners: ["src/triggers/"],
		fix: "the schedules belong to src/triggers/: read them with triggersOf and change them with editTriggers (src/triggers/edit.ts), which also re-arms the alarms",
	},
	{
		use: /\bItemDoc\b/,
		owners: ["src/items/", "src/triggers/runs.ts"],
		fix: "the items belong to src/items/: change them through its tools and helpers",
	},
	{
		use: /navigator\.clipboard|\.clipboardText\(/,
		owners: ["src/app/clipboard.ts"],
		fix: "copy and read the clipboard with copy and pasted from src/app/clipboard.ts, which picks the native read where the WebView cannot",
	},
	{
		use: /\bsection\(/,
		owners: ["src/agent/section.ts"],
		fix: "define a prompt section with appSection(key, budget, render) from src/agent/section.ts, so it has a budget and test/prompt.ts sees it",
	},
	{
		use: /\baddTools\b/,
		owners: ["src/agent/tool-filter.ts"],
		fix: "a tool result's control.addTools would switch back on a tool the bot's toolsets turned off; ToolFilterExtension (src/agent/tool-filter.ts) is the one place that reads it",
	},
	{
		use: /\bafterTool\b/,
		owners: ["src/agent/tool-filter.ts", "src/agent/codemode.ts"],
		fix: "afterTool hooks run in extension order and ToolFilterExtension must see the final control; add a new afterTool only before it in catalog.ts and list its file here",
	},
	{
		use: /\bBotIndex\b/,
		owners: ["src/agent/bots.ts", "src/agent/runtime.ts", "src/agent/bot-toolsets.ts"],
		fix: "read the bots with botsIn (src/agent/bots.ts) or runtime.bots(), which leave out a bot being removed; only the runtime edits the index, and BotToolsets a bot's toolset choices",
	},
	{
		use: /\bJSON\.parse\(/,
		owners: ["src/parse.ts"],
		fix: "parse JSON at the boundary with checkJson, decode or parseJson from src/parse.ts",
	},
	{
		use: /\bApp\.getState\(/,
		owners: ["src/agent/tools/apps.ts", "src/keepAlive.ts"],
		fix: "a tool opens a screen through openScreen (src/agent/tools/apps.ts), which decides whether pi may",
	},
];

function borrowed(file: string): Finding[] {
	const lines = readFileSync(file, "utf8").split("\n");
	return OWNED.filter(({ owners }) => !owners.some((owner) => file.endsWith(owner) || (owner.endsWith("/") && file.startsWith(owner)))).flatMap(({ use, fix }) =>
		lines.flatMap((line, index) => (use.test(line) ? [{ file, line: index + 1, rule: fix }] : [])),
	);
}

function javaRule(): Finding[] {
	return checkedFiles()
		.filter((file) => file.startsWith("android/app/src/main/") && file.endsWith(".java"))
		.map((file) => ({ file, line: 1, rule: "Android code is Kotlin: write this file as .kt" }));
}

// why: joined at run time so this file does not contain the address it forbids
const MAIN_INSTALLER = ["raw.githubusercontent.com", "geminixiang/pi-mobile/main/host/install.sh"].join("/");

function installerRule(): Finding[] {
	return checkedFiles().flatMap((file) =>
		readFileSync(file, "utf8")
			.split("\n")
			.flatMap((text, index) => (text.includes(MAIN_INSTALLER) ? [{ file, line: index + 1, rule: "install from the release (https://github.com/geminixiang/pi-mobile/releases/latest/download/install.sh), not main: the script on main can call a command the released pi-mobile does not have yet" }] : [])),
	);
}

function powershellRule(): Finding[] {
	return checkedFiles()
		.filter((file) => file.endsWith(".ps1") && !readFileSync(file).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])))
		.map((file) => ({ file, line: 1, rule: "save this script as UTF-8 with a BOM: Windows PowerShell 5.1 reads a .ps1 without one as the system code page, and its Chinese breaks the script" }));
}

const all = [
	...javaRule(),
	...installerRule(),
	...powershellRule(),
	...checkedFiles()
		.filter((file) => SCRIPT_FILE.test(file) && !DEVICE_SCRIPTS.test(file))
		.flatMap(findings),
	...checkedFiles()
		.filter((file) => SOURCE_FILE.test(file) && !file.startsWith("test/"))
		.flatMap(borrowed),
];
if (all.length > 0) {
	for (const finding of all) console.error(`${finding.file}:${finding.line}: ${finding.rule}`);
	console.error(`code-rules: ${all.length} findings`);
	process.exit(1);
}
console.log("code-rules: no casts, any, non-null assertions or swallowed catches; owned internals stay with their owners");
