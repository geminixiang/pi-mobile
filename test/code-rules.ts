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
		use: /\bsection\(/,
		owners: ["src/agent/section.ts"],
		fix: "define a prompt section with appSection(key, budget, render) from src/agent/section.ts, so it has a budget and test/prompt.ts sees it",
	},
	{
		use: /\bBotIndex\b/,
		owners: ["src/agent/bots.ts", "src/agent/runtime.ts"],
		fix: "read the bots with botsIn (src/agent/bots.ts) or runtime.bots(), which leave out a bot being removed; only the runtime edits the index",
	},
	{
		use: /\bJSON\.parse\(/,
		owners: ["src/agent/parse.ts"],
		fix: "parse JSON at the boundary with checkJson, decode or parseJson from src/agent/parse.ts",
	},
	{
		use: /\bApp\.getState\(/,
		owners: ["src/agent/tools/apps.ts", "src/app/keepAlive.ts"],
		fix: "a tool opens a screen through openScreen (src/agent/tools/apps.ts), which decides whether pi may",
	},
];

function borrowed(file: string): Finding[] {
	const lines = readFileSync(file, "utf8").split("\n");
	return OWNED.filter(({ owners }) => !owners.some((owner) => file.endsWith(owner) || (owner.endsWith("/") && file.startsWith(owner)))).flatMap(({ use, fix }) =>
		lines.flatMap((line, index) => (use.test(line) ? [{ file, line: index + 1, rule: fix }] : [])),
	);
}

const JAVA_LEFT = new Set([
	"AgentService.java",
	"AppsPlugin.java",
	"AssistRecognitionService.java",
	"AssistService.java",
	"AssistSession.java",
	"AssistSessionService.java",
	"Background.java",
	"BotFilesPlugin.java",
	"CalendarPlugin.java",
	"ContactsPlugin.java",
	"DatabasePlugin.java",
	"DndReceiver.java",
	"HeadphonesReceiver.java",
	"HealthPlugin.java",
	"KeepAlivePlugin.java",
	"LoopbackPlugin.java",
	"MainActivity.java",
	"NotificationsListener.java",
	"NotificationsPlugin.java",
	"NotificationStore.java",
	"PagePlugin.java",
	"PhonePlugin.java",
	"PhoneStatePlugin.java",
	"PhotosPlugin.java",
	"PiWebView.java",
	"PlacesCache.java",
	"RecordsPlugin.java",
	"ScannerPlugin.java",
	"Speaker.java",
	"StreamFetchPlugin.java",
	"SystemPlugin.java",
	"UsagePlugin.java",
	"VoicePlugin.java",
	"WebPages.java",
]);

function javaRule(): Finding[] {
	const java = checkedFiles().filter((file) => file.startsWith("android/app/src/main/java/") && file.endsWith(".java"));
	const names = new Set(java.map((file) => file.slice(file.lastIndexOf("/") + 1)));
	return [
		...java.filter((file) => !JAVA_LEFT.has(file.slice(file.lastIndexOf("/") + 1))).map((file) => ({ file, line: 1, rule: "new Android code is Kotlin: write this file as .kt" })),
		...[...JAVA_LEFT].filter((name) => !names.has(name)).map((name) => ({ file: "test/code-rules.ts", line: 1, rule: `${name} is gone (moved to Kotlin?): remove it from JAVA_LEFT` })),
	];
}

const all = [
	...javaRule(),
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
