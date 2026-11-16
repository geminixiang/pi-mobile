import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
	if (classNames(node).some((name) => OLD_BOXES.has(name))) return "a .menu or .group box around a list: put the list on the background with RowList (src/ui/RowList.tsx), as DESIGN.md § Components says";
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

const SOURCE_FILE = /\.(ts|tsx|java|kt|swift|m|h)$/;
const TYPESCRIPT = /\.tsx?$/;

const OWNED: { use: RegExp; owners: readonly string[]; fix: string; only?: RegExp }[] = [
	{
		use: /\b(XCTRunnerDaemonSession|XCSynthesizedEventRecord|XCAXClient_iOS)\b/,
		owners: ["ios/AgentScreen/"],
		fix: "private XCTest automation belongs only to the open source edition: move it to ios/AgentScreen/InProcess.m and call it through PhoneScreen",
	},
	{
		use: /\bPiEdition\b/,
		owners: ["ios/AgentScreen/", "ios/App/App/MainViewController.swift"],
		fix: "edition registration has one seam: define PiEdition in ios/AgentScreen/Edition.swift and resolve it only in MainViewController.swift",
	},
	{
		use: /\bnew WebView\(|[=(] *WebView\(|\bWKWebView\(/,
		owners: ["WebPages.kt", "WebPages.swift"],
		fix: "a web view on pi's own profile shares what is pi's (on Android its renderer, so a third-party page can freeze pi; on iOS its cookies and storage): create it with WebPages.create, which gives it a profile of its own",
	},
	{
		use: /PhoneScreenService\.(?!canStartActivities\b)\w+/,
		owners: ["PhoneScreenService.kt", "PhoneScreenPlugin.kt", "ScreenActor.kt", "ScreenElements.kt", "ScreenMoney.kt"],
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
		owners: ["src/section.ts"],
		fix: "define a prompt section with appSection(key, budget, render) from src/section.ts, so it has a budget and test/prompt.ts sees it",
	},
	{
		use: /\bAgentScreen\b|dev\.geminixiang\.agentscreen/,
		owners: ["src/plugins/agent-screen.ts", "src/plugins/index.ts", "src/phone-screen/background.ts", "android/agentscreen/", "android/app/src/oss/"],
		fix: "the background screen is an experiment of the open source edition only (docs/design/background-screen.md): its native code stays in android/agentscreen/ and android/app/src/oss/, its contract in src/plugins/agent-screen.ts, and only src/phone-screen/background.ts reaches it: it decides which screen a step runs on and gives the settings page its setup (backgroundSetup)",
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
		owners: ["src/time.ts"],
		fix: "wait with sleep(ms) from src/time.ts",
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

// why: counts imports that keep src/ folders in one tangle (a folder-level cycle); it only goes down, toward folders that import in one direction
const TANGLED_IMPORTS = 403;
const RELATIVE_IMPORT = /^import (?:[^;]*? from )?"(\.[^"]+)";/gm;

function folderOf(file: string): string {
	const [, top = "", rest] = file.split("/");
	return rest === undefined ? file : top;
}

function tangleRule(): Finding[] {
	const imports = checkedFiles()
		.filter((file) => file.startsWith("src/") && SCRIPT_FILE.test(file))
		.flatMap((file) => {
			const source = readFileSync(file, "utf8");
			return [...source.matchAll(RELATIVE_IMPORT)].flatMap((match) => {
				const from = folderOf(file);
				const to = folderOf(join(dirname(file), match[1] ?? ""));
				return from === to || !to ? [] : [{ file, line: source.slice(0, match.index).split("\n").length, from, to }];
			});
		});
	const next = new Map<string, Set<string>>();
	for (const { from, to } of imports) next.set(from, (next.get(from) ?? new Set()).add(to));
	const reaches = (start: string, goal: string): boolean => {
		const seen = new Set<string>();
		const queue = [start];
		for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
			if (at === goal) return true;
			if (seen.has(at)) continue;
			seen.add(at);
			queue.push(...(next.get(at) ?? []));
		}
		return false;
	};
	const tangled = imports.filter(({ from, to }) => reaches(to, from));
	const pairs = [...new Set(tangled.map(({ from, to }) => `${from} → ${to}`))].sort().join(", ");
	if (tangled.length > TANGLED_IMPORTS)
		return [{ file: "test/code-rules.ts", line: 1, rule: `${tangled.length} imports keep src/ folders in a cycle, ${TANGLED_IMPORTS} allowed (TANGLED_IMPORTS): an import may not point at a folder that leads back to its own; move the shared piece down into a folder both can import, or pass it in. Tangled: ${pairs}` }];
	if (tangled.length < TANGLED_IMPORTS) return [{ file: "test/code-rules.ts", line: 1, rule: `${tangled.length} tangled imports, fewer than TANGLED_IMPORTS (${TANGLED_IMPORTS}): lower it to ${tangled.length} so the ratchet holds` }];
	return [];
}

// why: classes that a library adds to the markup it renders (remark-gfm's task lists), so no source file names them
const EXTERNAL_CLASSES = new Set(["task-list-item"]);
const CSS_CLASS = /\.([a-zA-Z][\w-]*)/g;

function unusedClassRule(): Finding[] {
	const sheets = ["src/app/styles.css", "src/app/index.css"];
	const code = [...checkedFiles().filter((file) => file.startsWith("src/") && SCRIPT_FILE.test(file)), "index.html"].map((file) => readFileSync(file, "utf8")).join("\n");
	const named = (name: string) => new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(code);
	const built = (name: string) => name.split("-").some((_, index, parts) => index > 0 && code.includes(`${parts.slice(0, index).join("-")}-\${`));
	return sheets.flatMap((sheet) => {
		const lines = readFileSync(sheet, "utf8").replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " ")).split("\n");
		const seen = new Set<string>();
		return lines.flatMap((line, index) =>
			[...line.matchAll(CSS_CLASS)].flatMap(([, name = ""]) => {
				if (seen.has(name) || EXTERNAL_CLASSES.has(name) || named(name) || built(name)) return [];
				seen.add(name);
				return [{ file: sheet, line: index + 1, rule: `.${name} is styled but no component uses it: delete the rule, or use the class` }];
			}),
		);
	});
}

// why: counts let declarations in src/, which only goes down: a value that changes is a const computed again or a reducer
const LETS = 115;
const LET = /^\s*(?:export )?let /gm;

function letRule(): Finding[] {
	const count = checkedFiles()
		.filter((file) => file.startsWith("src/") && SCRIPT_FILE.test(file))
		.reduce((sum, file) => sum + [...readFileSync(file, "utf8").matchAll(LET)].length, 0);
	if (count > LETS) return [{ file: "test/code-rules.ts", line: 1, rule: `${count} let declarations in src/, ${LETS} allowed (LETS): use const and compute the value where it is needed, or a reducer for state that moves` }];
	if (count < LETS) return [{ file: "test/code-rules.ts", line: 1, rule: `${count} let declarations, fewer than LETS (${LETS}): lower it to ${count} so the ratchet holds` }];
	return [];
}

const MAX_LINES = 400;
// why: files already past MAX_LINES, each held at its size until it is split by responsibility; the numbers only go down
const LONG_FILES: Record<string, number> = {
	"src/agent/files/phone-env.ts": 445,
	"src/agent/mcp.ts": 473,
	"src/agent/runtime.ts": 659,
	"src/agent/tools/tw-stocks.ts": 465,
	"src/app/App.tsx": 562,
	"src/app/Chat.tsx": 475,
	"src/app/Links.tsx": 435,
	"src/app/Message.tsx": 518,
	"src/app/Settings.tsx": 766,
	"src/triggers/runs.ts": 529,
};

function lengthRule(): Finding[] {
	return checkedFiles()
		.filter((file) => file.startsWith("src/") && SCRIPT_FILE.test(file))
		.flatMap((file) => {
			const lines = readFileSync(file, "utf8").split("\n").length - 1;
			const allowed = LONG_FILES[file] ?? MAX_LINES;
			if (lines > allowed) return [{ file, line: 1, rule: `${lines} lines, ${allowed} allowed: split it by responsibility (a feature's logic, its view, its plugin) instead of growing it` }];
			if (allowed > MAX_LINES && lines < allowed) return [{ file, line: 1, rule: `${lines} lines, fewer than its LONG_FILES entry (${allowed}): lower it to ${Math.max(lines, MAX_LINES)}${lines <= MAX_LINES ? " by removing the entry" : ""}` }];
			return [];
		});
}

const FEATURES = /^src\/(triggers|items|jobs|workbench|browser|interaction|computer-agents|phone-screen|plugins|computer)\//;
// why: feature files that still take the whole AgentRuntime; each moves to its feature's own handle (the module-layering plan), and the list only shrinks
const RUNTIME_USERS = new Set(["src/triggers/TriggerRow.tsx", "src/triggers/TriggerList.tsx", "src/triggers/events.ts", "src/items/ItemSheet.tsx", "src/items/ItemActions.tsx", "src/workbench/Workbench.tsx", "src/workbench/Stage.tsx"]);

function runtimeRule(): Finding[] {
	return checkedFiles()
		.filter((file) => FEATURES.test(file) && SCRIPT_FILE.test(file))
		.flatMap((file) => {
			const uses = /from "[^"]*agent\/runtime\.ts"/.test(readFileSync(file, "utf8"));
			if (uses && !RUNTIME_USERS.has(file)) return [{ file, line: 1, rule: "a feature takes its own handle (its store with subscribe and its verbs), not the whole AgentRuntime: pass the handle in as a prop" }];
			if (!uses && RUNTIME_USERS.has(file)) return [{ file, line: 1, rule: "no longer imports AgentRuntime: remove it from RUNTIME_USERS so the list only shrinks" }];
			return [];
		});
}

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

const APP_ID = /\b(?:com|net|org|tw|jp|cn|kr)\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*/giu;
const SYSTEM_IDS = ["com.android.", "com.google.android.", "com.apple.", "com.samsung.android.", "com.sec.android.", "com.osp.", "dev.geminixiang."];
// why: Rex is a terminal host that src/computer-agents/ drives as a backend, a supported interface rather than knowledge about the user's apps
const BACKEND_IDS = ["com.superlogical.rex"];

function generalAgentRule(): Finding[] {
	return checkedFiles()
		.filter((file) => file.startsWith("src/"))
		.flatMap((file) =>
			readFileSync(file, "utf8")
				.split("\n")
				.flatMap((text, index) =>
					[...text.matchAll(APP_ID)]
						.map((match) => match[0])
						.filter((id) => ![...SYSTEM_IDS, ...BACKEND_IDS].some((known) => id.startsWith(known)))
						.map((id) => ({ file, line: index + 1, rule: `${id} names one third-party app: the agent stays general and learns the user's apps itself (installed apps from the device, know-how from its own notes); write the mechanism, never a table, prompt or default about a particular app` })),
				),
		);
}

const AGENTS_WORDS = 2800;

function agentsSizeRule(): Finding[] {
	const words = readFileSync("AGENTS.md", "utf8").split(/\s+/u).filter(Boolean).length;
	if (words > AGENTS_WORDS) return [{ file: "AGENTS.md", line: 1, rule: `${words} words, ${AGENTS_WORDS} allowed (AGENTS_WORDS): make room by cutting or merging a rule, or turn prose into a check and delete the prose` }];
	if (words < AGENTS_WORDS) return [{ file: "test/code-rules.ts", line: 1, rule: `AGENTS.md has ${words} words, fewer than AGENTS_WORDS (${AGENTS_WORDS}): lower it to ${words} so the ratchet holds` }];
	return [];
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

const EFFECT_HOOKS = new Set(["useEffect", "useLayoutEffect", "useInsertionEffect"]);
const TIMERS = new Set(["setTimeout", "setInterval", "requestAnimationFrame", "requestIdleCallback", "postTask"]);
const TIMER_OWNER = "src/time.ts";

type TimingCall = { kind: "effect" | "timer"; name: string; line: number };

function timingCalls(file: string): TimingCall[] {
	const source = readFileSync(file, "utf8");
	const found: TimingCall[] = [];
	const lineOf = (node: Node) => source.slice(0, node.start).split("\n").length;
	const visit = (node: unknown) => {
		if (!isNode(node)) return;
		if (node.type === "CallExpression" && isNode(node.callee)) {
			const callee = node.callee.type === "MemberExpression" ? node.callee.property : node.callee;
			const name = isNode(callee) && typeof callee.name === "string" ? callee.name : "";
			const onAbortSignal = node.callee.type === "MemberExpression" && isNode(node.callee.object) && node.callee.object.name === "AbortSignal";
			if (EFFECT_HOOKS.has(name)) found.push({ kind: "effect", name, line: lineOf(node) });
			if (TIMERS.has(name)) found.push({ kind: "timer", name, line: lineOf(node) });
			if (onAbortSignal && name === "timeout") found.push({ kind: "timer", name: "AbortSignal.timeout", line: lineOf(node) });
		}
		children(node).forEach(visit);
	};
	visit(parseSync(file, source).program);
	return found;
}

const EFFECT_FIX =
	"a store, or a native, window or Capacitor event → useSubscribed or useStore (src/ui/subscribed.ts), or useSyncExternalStore; loading → useLoaded (src/ui/loaded.ts); work on an element (measure, focus, scroll, observe, clean up when it leaves) → a ref callback that returns its cleanup; a value from state or props → compute it during render; state to reset on a new id → a key; a reaction to a tap or a gesture → do it in the event handler (docs/effects.md)";
const TIMER_FIX =
	"call a named helper from src/time.ts (sleep, after, every, deadline, nextFrame, eachFrame, afterPaint) and keep the cancel it returns; a value that changes with time → a store whose subscribe starts the helper; a delay that waits for something → listen for that event (docs/effects.md)";

function effectRule(): Finding[] {
	return checkedFiles()
		.filter((file) => file.startsWith("src/") && SCRIPT_FILE.test(file))
		.flatMap((file) =>
			timingCalls(file)
				.filter((call) => call.kind === "effect" || file !== TIMER_OWNER)
				.map((call) => ({
					file,
					line: call.line,
					rule: call.kind === "effect" ? `${call.name} is not used in src/: ${EFFECT_FIX}` : `${call.name} is called only in ${TIMER_OWNER}: ${TIMER_FIX}`,
				})),
		);
}

const REF_FIX =
	"a ref callback is called again whenever its function changes, so one made each render or with dependencies is an effect: give it useCallback(…, []) so it follows only its element's life (observe, focus, clean up), and move what follows a prop or state to the handler or the store that changes it, or key the element (docs/effects.md)";
const SNAPSHOT_FIX =
	"useSyncExternalStore whose snapshot never changes only borrows subscribe as a lifecycle: return the value the source holds, or react in the source's own listener (docs/effects.md)";

function isFunction(node: unknown): boolean {
	return isNode(node) && (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression");
}

function onlyStoresElement(fn: Node): boolean {
	const body = isNode(fn.body) && fn.body.type === "BlockStatement" && Array.isArray(fn.body.body) && fn.body.body.length === 1 ? fn.body.body[0] : fn.body;
	const expression = isNode(body) && body.type === "ExpressionStatement" ? body.expression : body;
	return isNode(expression) && expression.type === "AssignmentExpression" && isNode(expression.left) && expression.left.type === "MemberExpression" && isNode(expression.left.property) && expression.left.property.name === "current";
}

function returnsConstant(fn: Node): boolean {
	const body = fn.body;
	if (!isNode(body)) return false;
	if (body.type === "Literal") return true;
	if (body.type === "Identifier") return body.name === "undefined";
	return body.type === "BlockStatement" && Array.isArray(body.body) && body.body.length === 0;
}

function lifecycleFindings(file: string): Finding[] {
	const source = readFileSync(file, "utf8");
	const found: Finding[] = [];
	const declared = new Map<string, { init: Node; top: boolean }>();
	const lineOf = (node: Node) => source.slice(0, node.start).split("\n").length;
	const collect = (node: unknown, top: boolean) => {
		if (!isNode(node)) return;
		if (node.type === "VariableDeclarator" && isNode(node.id) && typeof node.id.name === "string" && isNode(node.init)) declared.set(node.id.name, { init: node.init, top });
		const inside = top && node.type !== "FunctionDeclaration" && !isFunction(node) && node.type !== "ClassBody";
		for (const child of children(node)) collect(child, inside);
	};
	const calls = (node: Node, name: string) => node.type === "CallExpression" && isNode(node.callee) && node.callee.name === name && Array.isArray(node.arguments);
	const refIsEffect = (value: Node): boolean => {
		if (isFunction(value)) return !onlyStoresElement(value);
		if (value.type !== "Identifier" || typeof value.name !== "string") return false;
		const known = declared.get(value.name);
		if (!known) return false;
		if (isFunction(known.init)) return !known.top && !onlyStoresElement(known.init);
		if (!calls(known.init, "useCallback") || !Array.isArray(known.init.arguments)) return false;
		const [fn, deps] = known.init.arguments;
		const stable = isNode(deps) && deps.type === "ArrayExpression" && Array.isArray(deps.elements) && deps.elements.length === 0;
		return !stable && !(isNode(fn) && isFunction(fn) && onlyStoresElement(fn));
	};
	const snapshotIsConstant = (value: unknown): boolean => {
		if (!isNode(value)) return false;
		if (isFunction(value)) return returnsConstant(value);
		if (value.type !== "Identifier" || typeof value.name !== "string") return false;
		const known = declared.get(value.name);
		return known !== undefined && isFunction(known.init) && returnsConstant(known.init);
	};
	const visit = (node: unknown) => {
		if (!isNode(node)) return;
		const jsxRef = node.type === "JSXAttribute" && isNode(node.name) && node.name.name === "ref" && isNode(node.value) && node.value.type === "JSXExpressionContainer" ? node.value.expression : undefined;
		const propertyRef = node.type === "Property" && isNode(node.key) && node.key.name === "ref" ? node.value : undefined;
		const ref = jsxRef ?? propertyRef;
		if (isNode(ref) && refIsEffect(ref)) found.push({ file, line: lineOf(node), rule: REF_FIX });
		if (calls(node, "useSyncExternalStore") && Array.isArray(node.arguments) && snapshotIsConstant(node.arguments[1])) found.push({ file, line: lineOf(node), rule: SNAPSHOT_FIX });
		children(node).forEach(visit);
	};
	const program = parseSync(file, source).program;
	collect(program, true);
	visit(program);
	return found;
}

function lifecycleRule(): Finding[] {
	return checkedFiles()
		.filter((file) => file.startsWith("src/") && SCRIPT_FILE.test(file))
		.flatMap(lifecycleFindings);
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

const REACHING_IMPORT = /(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"?]+)|new URL\(\s*"(\.{1,2}\/[^"?]+)/g;
const BUILD_ENTRY = /"(?:\.\.?\/)*(src\/[^"`?]+\.tsx?)"/g;

function unreachableFiles(): Finding[] {
	const sources = checkedFiles().filter((file) => file.startsWith("src/") && /\.tsx?$/.test(file));
	const buildEntries = checkedFiles()
		.filter((file) => file.startsWith("vite-plugins/") || file.startsWith("vite.config"))
		.flatMap((file) => [...readFileSync(file, "utf8").matchAll(BUILD_ENTRY)].map((match) => match[1] ?? ""));
	const roots = sources.filter((file) => file === "src/main.tsx" || file.startsWith(EXPORTS_ANY_NAME) || file.endsWith(".d.ts") || buildEntries.includes(file));
	const reached = new Set(roots);
	const queue = [...roots];
	for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
		for (const match of readFileSync(file, "utf8").matchAll(REACHING_IMPORT)) {
			const target = join(dirname(file), match[1] ?? match[2] ?? "");
			if (reached.has(target)) continue;
			reached.add(target);
			queue.push(target);
		}
	}
	return sources
		.filter((file) => !reached.has(file))
		.map((file) => ({ file, line: 1, rule: "no file the app runs imports this, only tests do: wire it into the app, or delete it with its tests (a test runs product code, not code kept for the test)" }));
}

const all = [
	...unreachableFiles(),
	...unusedClassRule(),
	...letRule(),
	...lengthRule(),
	...runtimeRule(),
	...tangleRule(),
	...unusedExports(),
	...effectRule(),
	...lifecycleRule(),
	...javaRule(),
	...viewportRule(),
	...installerRule(),
	...generalAgentRule(),
	...agentsSizeRule(),
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
