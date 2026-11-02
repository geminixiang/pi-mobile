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

function rule(node: Node, explained: boolean): string | undefined {
	if (node.type === "TSAsExpression" && !isConstAssertion(node) && !explained) return "as cast without a why: line above it";
	if (node.type === "TSTypeAssertion") return "<T> cast";
	if (node.type === "TSNonNullExpression") return "non-null assertion";
	if (node.type === "TSAnyKeyword") return "any";
	if (node.type === "CallExpression" && isSwallowingCatch(node)) return "catch that swallows the error";
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
	return OWNED.filter(({ owners }) => !owners.some((owner) => file.endsWith(owner))).flatMap(({ use, fix }) =>
		lines.flatMap((line, index) => (use.test(line) ? [{ file, line: index + 1, rule: fix }] : [])),
	);
}

const all = [
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
