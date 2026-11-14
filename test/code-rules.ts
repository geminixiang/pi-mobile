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

const OLD_BOXES = new Set(["menu", "group"]);

const SPACES = /\s+/;

function texts(node: Node): string[] {
	if (node.type === "Literal") return typeof node.value === "string" ? [node.value] : [];
	if (node.type === "TemplateElement") return isNode(node.value) && typeof node.value.cooked === "string" ? [node.value.cooked] : [];
	return children(node).flatMap(texts);
}

function classNames(node: Node): string[] {
	if (node.type !== "JSXAttribute" || !isNode(node.name) || node.name.name !== "className" || !isNode(node.value)) return [];
	return texts(node.value).flatMap((text) => text.split(SPACES));
}

function rule(node: Node, explained: boolean): string | undefined {
	if (node.type === "TSAsExpression" && !isConstAssertion(node) && !explained) return "as cast without a why: line above it";
	if (node.type === "TSTypeAssertion") return "<T> cast";
	if (node.type === "TSNonNullExpression") return "non-null assertion";
	if (node.type === "TSAnyKeyword") return "any";
	if (node.type === "CallExpression" && isSwallowingCatch(node)) return "catch that swallows the error";
	if (classNames(node).some((name) => OLD_BOXES.has(name))) return "a .menu or .group box around a list: put the list on the background with RowList (src/app/RowList.tsx), as DESIGN.md § Components says";
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
const TYPESCRIPT = /\.tsx?$/;

const OWNED: { use: RegExp; owners: readonly string[]; fix: string; only?: RegExp }[] = [
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
		use: /randomUUID\(\)\.(slice|replaceAll)\(/,
		owners: [],
		fix: "make a short id with randomHex(bytes) from src/encoding.ts (randomHex(4) is 8 hex characters)",
		only: TYPESCRIPT,
	},
	{
		use: /setTimeout\(resolve\b/,
		owners: ["src/promise.ts"],
		fix: "wait with sleep(ms) from src/promise.ts",
		only: TYPESCRIPT,
	},
	{
		use: /padStart\(2, "0"\)/,
		owners: ["src/time.ts", "src/encoding.ts"],
		fix: "pad two digits with pad from src/time.ts",
		only: TYPESCRIPT,
	},
	{
		use: /\b60_000\b/,
		owners: ["src/time.ts"],
		fix: "write minutes with MINUTE (and HOUR, DAY) from src/time.ts",
		only: TYPESCRIPT,
	},
	{
		use: /["'`]job:/,
		owners: ["src/jobs/background.ts"],
		fix: "name a background job with jobAgent(id), test one with isJob(agent), read its id with jobIdOf(agent) (src/jobs/background.ts)",
		only: TYPESCRIPT,
	},
	{
		use: /split\("\/"\)\.(at\(-1\)|pop\(\))|lastIndexOf\("\/"\) \+ 1/,
		owners: ["src/agent/mime.ts"],
		fix: "take the last part of a path with baseName(path) from src/agent/mime.ts",
		only: TYPESCRIPT,
	},
	{
		use: /\\\.html\?\$/,
		owners: ["src/agent/mime.ts"],
		fix: "tell an HTML file with isHtml(path) from src/agent/mime.ts",
		only: TYPESCRIPT,
	},
	{
		use: /\?\? Number\.MAX_SAFE_INTEGER\) -/,
		owners: ["src/time.ts"],
		fix: "sort by an optional time with soonest(at) from src/time.ts",
		only: TYPESCRIPT,
	},
	{
		use: /\bApp\.getState\(/,
		owners: ["src/agent/tools/apps.ts", "src/keepAlive.ts"],
		fix: "a tool opens a screen through openScreen (src/agent/tools/apps.ts), which decides whether pi may",
	},
];

const LAYERS: { folder: string; never: RegExp; fix: string }[] = [
	{
		folder: "src/computer/",
		never: /from "[^"]*\/agent\/sandbox\//,
		fix: "src/computer/ reaches a computer and knows nothing of sandboxes: move what it needs from src/agent/sandbox/ into src/computer/, so sandbox depends on computer and never the other way",
	},
];

function layered(file: string): Finding[] {
	const lines = readFileSync(file, "utf8").split("\n");
	return LAYERS.filter(({ folder }) => file.startsWith(folder)).flatMap(({ never, fix }) =>
		lines.flatMap((line, index) => (never.test(line) ? [{ file, line: index + 1, rule: fix }] : [])),
	);
}

function borrowed(file: string): Finding[] {
	const lines = readFileSync(file, "utf8").split("\n");
	return OWNED.filter(({ owners, only }) => (only === undefined || only.test(file)) && !owners.some((owner) => file.endsWith(owner) || (owner.endsWith("/") && file.startsWith(owner)))).flatMap(({ use, fix }) =>
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

function moduleExtensionRule(): Finding[] {
	return checkedFiles()
		.filter((file) => file.endsWith(".mjs") || file.endsWith(".cjs"))
		.map((file) => ({ file, line: 1, rule: "name this script .js: package.json sets \"type\": \"module\", so a .js file is already an ES module" }));
}

function powershellRule(): Finding[] {
	return checkedFiles()
		.filter((file) => file.endsWith(".ps1") && !readFileSync(file).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])))
		.map((file) => ({ file, line: 1, rule: "save this script as UTF-8 with a BOM: Windows PowerShell 5.1 reads a .ps1 without one as the system code page, and its Chinese breaks the script" }));
}

function viewportRule(): Finding[] {
	const lines = readFileSync("index.html", "utf8").split("\n");
	const line = lines.findIndex((text) => text.includes('name="viewport"'));
	return lines[line]?.includes("maximum-scale=1") ? [] : [{ file: "index.html", line: line + 1, rule: "keep maximum-scale=1 in the viewport: iOS zooms the page into any field with text under 16px and never zooms back, so the whole app stays enlarged" }];
}

const TIMING = new Set(["useEffect", "useLayoutEffect", "setTimeout", "setInterval", "requestAnimationFrame"]);
const EFFECTS: Record<string, number> = {
	"src/agent/chatgpt.ts": 1,
	"src/agent/files/phone-env.ts": 2,
	"src/agent/network.ts": 1,
	"src/agent/reach.ts": 2,
	"src/agent/sandbox/container.ts": 1,
	"src/agent/sandbox/phone-connection.ts": 1,
	"src/agent/traffic.ts": 1,
	"src/app/App.tsx": 12,
	"src/app/BotPanel.tsx": 2,
	"src/app/BotSheet.tsx": 1,
	"src/app/Chat.tsx": 7,
	"src/app/Composer.tsx": 5,
	"src/app/ContextCard.tsx": 1,
	"src/app/FileViewer.tsx": 1,
	"src/app/HostsGroup.tsx": 3,
	"src/app/Links.tsx": 2,
	"src/app/McpGroup.tsx": 1,
	"src/app/MemoryView.tsx": 1,
	"src/app/Mermaid.tsx": 1,
	"src/app/PageStack.tsx": 2,
	"src/app/PromptDial.tsx": 4,
	"src/app/Settings.tsx": 3,
	"src/app/SidePanel.tsx": 6,
	"src/app/SignIn.tsx": 2,
	"src/app/background.ts": 1,
	"src/app/briefly.ts": 2,
	"src/app/layers.ts": 1,
	"src/app/loaded.ts": 3,
	"src/app/press.ts": 1,
	"src/app/sideGesture.ts": 1,
	"src/app/streaming.tsx": 3,
	"src/app/voice.ts": 1,
	"src/browser/BrowserSheet.tsx": 6,
	"src/browser/tool.ts": 1,
	"src/computer/resumable-socket.ts": 2,
	"src/interaction/PageFrame.tsx": 2,
	"src/items/ItemSheet.tsx": 1,
	"src/jobs/JobsContext.ts": 2,
	"src/jobs/JobsStrip.tsx": 2,
	"src/log.ts": 1,
	"src/promise.ts": 1,
	"src/triggers/events.ts": 1,
	"src/workbench/Surface.tsx": 3,
};

function timingCalls(file: string): number {
	const source = readFileSync(file, "utf8");
	let count = 0;
	const visit = (node: unknown) => {
		if (!isNode(node)) return;
		if (node.type === "CallExpression" && isNode(node.callee)) {
			const callee = node.callee.type === "MemberExpression" ? node.callee.property : node.callee;
			if (isNode(callee) && typeof callee.name === "string" && TIMING.has(callee.name)) count += 1;
		}
		children(node).forEach(visit);
	};
	visit(parseSync(file, source).program);
	return count;
}

const EFFECT_FIX =
	"an external store → useSubscribed (src/app/subscribed.ts) or useSyncExternalStore; a value from state or props → compute it during render; a reaction to a tap or a gesture → do it in the event handler; waiting → listen for the event it waits for (docs/effects.md)";

function effectRule(): Finding[] {
	const files = new Set(checkedFiles());
	const gone = Object.keys(EFFECTS)
		.filter((file) => !files.has(file))
		.map((file) => ({ file: "test/code-rules.ts", line: 1, rule: `EFFECTS lists ${file}, which no longer exists: remove it` }));
	return [...gone, ...checkedFiles()
		.filter((file) => file.startsWith("src/") && SCRIPT_FILE.test(file))
		.flatMap((file) => {
			const used = timingCalls(file);
			const allowed = EFFECTS[file] ?? 0;
			if (used > allowed)
				return [{ file, line: 1, rule: `${used} useEffect, useLayoutEffect or timer calls, ${allowed} allowed in EFFECTS (test/code-rules.ts): use ${EFFECT_FIX}. A legitimate effect (a native listener, a measured frame in the gesture code) raises the count with the user's approval` }];
			if (used < allowed) return [{ file, line: 1, rule: `${used} useEffect, useLayoutEffect or timer calls, fewer than the ${allowed} in EFFECTS (test/code-rules.ts): lower it to ${used} so the ratchet holds` }];
			return [];
		})];
}

const EXPORTED = /^export (?:declare )?(?:async )?(?:function\*?|const|let|class|type|interface|enum|abstract class) (\w+)/gm;
// why: a shim stands in for a Node module, so it exports that module's names whether or not this repo calls them
const EXPORTS_ANY_NAME = "src/shims/";

function unusedExports(): Finding[] {
	const scripts = checkedFiles().filter((file) => /\.(ts|tsx|js)$/.test(file));
	const sources = new Map(scripts.map((file) => [file, readFileSync(file, "utf8")]));
	return [...sources]
		.filter(([file]) => file.startsWith("src/") && !file.startsWith(EXPORTS_ANY_NAME))
		.flatMap(([file, source]) =>
			[...source.matchAll(EXPORTED)].flatMap((match) => {
				const name = match[1] ?? "";
				const word = new RegExp(`\\b${name}\\b`);
				if ([...sources].some(([other, text]) => other !== file && word.test(text))) return [];
				return [{ file, line: source.slice(0, match.index).split("\n").length, rule: `${name} is exported but no other file uses it: drop the export, or delete it if this file does not use it either` }];
			}),
		);
}

const all = [
	...unusedExports(),
	...effectRule(),
	...javaRule(),
	...viewportRule(),
	...installerRule(),
	...powershellRule(),
	...moduleExtensionRule(),
	...checkedFiles()
		.filter((file) => SCRIPT_FILE.test(file) && !DEVICE_SCRIPTS.test(file))
		.flatMap(findings),
	...checkedFiles()
		.filter((file) => SOURCE_FILE.test(file) && !file.startsWith("test/"))
		.flatMap(borrowed),
	...checkedFiles()
		.filter((file) => SOURCE_FILE.test(file))
		.flatMap(layered),
];
if (all.length > 0) {
	for (const finding of all) console.error(`${finding.file}:${finding.line}: ${finding.rule}`);
	console.error(`code-rules: ${all.length} findings`);
	process.exit(1);
}
console.log("code-rules: no casts, any, non-null assertions or swallowed catches; owned internals stay with their owners; src/computer/ never imports src/agent/sandbox/; every export is used elsewhere");
