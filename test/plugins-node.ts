import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { PhoneScreen, KEYS as PHONE_KEYS, keysFor } from "../src/phone-screen/plugin.ts";
import { Browser, KEYS as BROWSER_KEYS, MAX_TABS } from "../src/browser/plugin.ts";
import { coverage, kotlinKeys, kotlinSteps, swiftBranches } from "./screen/branches.ts";
import type { Methods } from "../src/plugins/define.ts";
import { PLUGINS } from "../src/plugins/index.ts";
import { ACTIVITIES, When } from "../src/triggers/plugin.ts";
import { exitOnFailures, plain, snapshotFailures, sourcesMatching } from "./snapshot.ts";

const SNAPSHOT = new URL("./plugins.snapshot.json", import.meta.url);
const ANDROID = new URL("../android/app/src/main/java/dev/geminixiang/pimobile/", import.meta.url);
const ANDROID_OSS = new URL("../android/app/src/oss/java/dev/geminixiang/pimobile/", import.meta.url);
const IOS = new URL("../ios/App/App/", import.meta.url);
const IOS_SCREEN = new URL("../ios/AgentScreen/", import.meta.url);
const INHERITED_ON_ANDROID = new Set(["checkPermissions", "requestPermissions"]);

function scan(directory: URL, extensions: string[], plugin: RegExp, methods: (source: string) => string[]): Map<string, Set<string>> {
	const found = new Map<string, Set<string>>();
	for (const file of readdirSync(directory).filter((name) => extensions.some((extension) => name.endsWith(extension)))) {
		const source = readFileSync(new URL(file, directory), "utf8");
		const name = plugin.exec(source)?.[1];
		if (name) found.set(name, new Set(methods(source)));
	}
	return found;
}

const androidPlugins = (directory: URL) =>
	scan(directory, [".kt"], /@CapacitorPlugin\(\s*name\s*=\s*"(\w+)"/, (source) =>
		[...source.matchAll(/@PluginMethod(?:\([^)]*\))?(?:\s+@\w+(?:\([^)]*\))?)*\s+fun\s+(\w+)\s*\(/g)].flatMap((match) => (match[1] ? [match[1]] : [])),
	);
const android = new Map([...androidPlugins(ANDROID), ...androidPlugins(ANDROID_OSS)]);
const iosPlugins = (directory: URL) => scan(directory, [".swift"], /jsName\s*=\s*"(\w+)"/, (source) => [...(/pluginMethods[^=]*=\s*\[([^\]]*)\]/s.exec(source)?.[1] ?? "").matchAll(/"(\w+)"/g)].flatMap((match) => (match[1] ? [match[1]] : [])));
const ios = new Map([...iosPlugins(IOS), ...iosPlugins(IOS_SCREEN)]);

const failures: string[] = [];
const contracts = new Map<string, Set<string>>(PLUGINS.map((plugin) => [plugin.name, new Set(Object.keys(plugin.contract.methods))]));

for (const [platform, found] of [["Android", android], ["iOS", ios]] as const) {
	for (const [name, methods] of found) {
		const declared = contracts.get(name);
		if (!declared) failures.push(`${platform} has a ${name} plugin with no contract in src/plugins/`);
		for (const method of methods) if (declared && !declared.has(method)) failures.push(`${platform} implements ${name}.${method}, which its contract does not declare`);
	}
}
for (const [name, methods] of contracts) {
	const implemented = android.get(name);
	for (const method of methods) if (!implemented?.has(method) && !INHERITED_ON_ANDROID.has(method)) failures.push(`${name}.${method} is in its contract but not implemented on Android`);
}

for (const file of readdirSync(ANDROID).filter((name) => name.endsWith(".kt"))) {
	if (/\bcall\.getLong\(/.test(readFileSync(new URL(file, ANDROID), "utf8"))) {
		failures.push(`${file} reads a number with call.getLong, which returns its default for any number that fits in an int; use call.getData().optLong`);
	}
}

for (const [name, methods] of ios) {
	const missing = [...INHERITED_ON_ANDROID].filter((method) => contracts.get(name)?.has(method) && !methods.has(method));
	if (missing.length) failures.push(`iOS ${name} does not list ${missing.join(" and ")} in its pluginMethods: Capacitor still announces them to the page, and a call then never answers, so a tool waiting on the permission check hangs; implement them as CalendarPlugin.swift does`);
	if (methods.has("checkPermissions") && !methods.has("requestPermissions")) failures.push(`iOS ${name} reports permissions but cannot ask for them, so the permission card's 允許 does nothing: add requestPermissions to its pluginMethods`);
}

for (const file of readdirSync(ANDROID).filter((name) => name.endsWith(".kt"))) {
	if (/\.put\("\w+", cursor\.getString\((?:[^()]|\([^()]*\))*\)\)/.test(readFileSync(new URL(file, ANDROID), "utf8"))) {
		failures.push(`${file} puts a cursor string straight into a result: a null removes the key, and one row then fails the whole list against its contract; use cursor.getString(i).orEmpty() or skip the key`);
	}
}

const registering = sourcesMatching(/\bregisterPlugin\b/, ["plugins/define.ts"]);
if (registering.length) failures.push(`native plugins are declared with definePlugin in src/plugins/, not registerPlugin: ${registering.join(", ")}`);

const current = PLUGINS.map((plugin) => ({
	name: plugin.name,
	methods: Object.fromEntries(Object.entries<Methods[string]>(plugin.contract.methods).map(([method, { args, result }]) => [method, { args: plain(args), result: result ? plain(result) : null }])),
	events: Object.fromEntries(Object.entries(plugin.contract.events).map(([event, schema]) => [event, plain(schema)])),
	ios: Object.keys(plugin.contract.methods).filter((method) => ios.get(plugin.name)?.has(method)),
}));

function unregistered(directory: URL, extensions: string[], classOf: (source: string) => string | undefined, registry: string, registered: RegExp): string[] {
	const classes = readdirSync(directory)
		.filter((name) => extensions.some((extension) => name.endsWith(extension)))
		.flatMap((file) => classOf(readFileSync(new URL(file, directory), "utf8")) ?? []);
	const names = new Set([...readFileSync(new URL(registry, directory), "utf8").matchAll(registered)].map((match) => match[1]));
	return classes.filter((name) => !names.has(name));
}
const androidPluginClass = (source: string) => /\bclass (\w+)/.exec(source.slice(source.search(/@CapacitorPlugin\(/)))?.[1];
const androidMissing = unregistered(ANDROID, [".kt"], androidPluginClass, "MainActivity.kt", /registerPlugin\((\w+)::class\.java\)/g);
if (androidMissing.length) failures.push(`Android plugins not registered in MainActivity.onCreate, so their tools vanish without an error: ${androidMissing.join(", ")}; add registerPlugin(X::class.java)`);
const ossMissing = unregistered(ANDROID_OSS, [".kt"], androidPluginClass, "Edition.kt", /(\w+)::class\.java/g);
if (ossMissing.length) failures.push(`open source edition plugins not listed in android/app/src/oss/.../Edition.kt, so their tools vanish without an error: ${ossMissing.join(", ")}`);
const iosPluginClass = (source: string) => [...source.slice(0, Math.max(0, source.search(/jsName\s*=\s*"/))).matchAll(/class (\w+)/g)].at(-1)?.[1];
const iosMissing = unregistered(IOS, [".swift"], iosPluginClass, "MainViewController.swift", /registerPluginInstance\((\w+)\(\)\)/g);
if (iosMissing.length) failures.push(`iOS plugins not registered in MainViewController.capacitorDidLoad: ${iosMissing.join(", ")}; add bridge?.registerPluginInstance(X())`);
const iosOssMissing = unregistered(IOS_SCREEN, [".swift"], iosPluginClass, "Edition.swift", /\b(\w+Plugin)\(\)/g);
if (iosOssMissing.length) failures.push(`iOS open source plugins not registered: ${iosOssMissing.join(", ")}; add XPlugin() to plugins() in ios/AgentScreen/Edition.swift, never to MainViewController`);

const NATIVE = "android/app/src/main/java/dev/geminixiang/pimobile/";
function literals(schema: { const?: unknown; enum?: unknown }): string[] {
	if (typeof schema.const === "string") return [schema.const];
	return Array.isArray(schema.enum) ? schema.enum.filter((name): name is string => typeof name === "string") : [];
}
const phoneActions = PhoneScreen.contract.methods.act.args.properties.steps.items.anyOf.flatMap((option) => literals(option.properties.action));
const browserActions = Browser.contract.methods.act.args.properties.steps.items.anyOf.flatMap((option) => literals(option.properties.action));
const BACKENDS = [
	{ platform: "android", file: "ScreenActor.kt", owner: "ScreenStep", map: "GLOBAL_KEYS", actions: phoneActions, keys: PHONE_KEYS },
	{ platform: "android browser", file: "BrowserSteps.kt", owner: "Step", map: "KEY_CODES", actions: browserActions, keys: BROWSER_KEYS },
];
for (const backend of BACKENDS) {
	const kotlin = readFileSync(new URL(backend.file, ANDROID), "utf8");
	const stepFailures = coverage(backend.platform, backend.file, backend.actions, kotlinSteps(kotlin, backend.owner), "step");
	failures.push(...stepFailures, ...coverage(backend.platform, backend.file, backend.keys, kotlinKeys(kotlin, backend.map), "key"));
	if (stepFailures.length) continue;
	const [removed] = backend.actions;
	assert(removed);
	const without = kotlin.replace(`"${removed}" ->`, '"missing_test_branch" ->');
	const decoy = `${without}\nval decoy = "${removed}"`;
	assert(coverage(backend.platform, backend.file, backend.actions, kotlinSteps(decoy, backend.owner), "step").some((failure) => failure.includes(`claims ${removed}`)));
	assert(coverage(backend.platform, backend.file, backend.actions, kotlinSteps(decoy, backend.owner), "step").some((failure) => failure.includes("implements missing_test_branch")));
}
const browserSwift = readFileSync(new URL("BrowserSteps.swift", IOS), "utf8");
failures.push(...coverage("ios browser", "BrowserSteps.swift", browserActions, swiftBranches(browserSwift, "action"), "step"), ...coverage("ios browser", "BrowserSteps.swift", BROWSER_KEYS, swiftBranches(browserSwift, "key"), "key"));
const NATIVE_MAX_TABS = /MAX_TABS = (\d+)/;
for (const [file, directory] of [["BrowserPlugin.kt", ANDROID], ["BrowserPlugin.swift", IOS]] as const) {
	const kept = NATIVE_MAX_TABS.exec(readFileSync(new URL(file, directory), "utf8"))?.[1];
	if (Number(kept) !== MAX_TABS) failures.push(`${file} keeps ${kept} tabs for a Bot, src/browser/plugin.ts ${MAX_TABS}: the sheet stops offering a new tab at one number and the phone refuses at another; make MAX_TABS the same in both`);
}
const appStoreProject = readFileSync(new URL("../App.xcodeproj/project.pbxproj", IOS), "utf8");
const uncompiled = readdirSync(IOS).filter((name) => name.endsWith(".swift") && !appStoreProject.includes(`${name} in Sources`));
if (uncompiled.length) failures.push(`Swift files the App Store project does not compile, so only the open source edition (which takes the whole folder) builds: ${uncompiled.join(", ")}; add each to ios/App/App.xcodeproj/project.pbxproj as the other plugins are (PBXBuildFile, PBXFileReference, the App group, the Sources phase)`);
if (existsSync(IOS_SCREEN)) {
	const swift = readdirSync(IOS_SCREEN, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".swift"));
	const sources = swift.map((file) => ({ file, source: readFileSync(new URL(file, IOS_SCREEN), "utf8") }));
	const steps = sources.filter(({ source }) => swiftBranches(source, "action").length > 0);
	if (!steps.length) failures.push("ios claims PhoneScreen steps but ios/AgentScreen/ has no action switch: implement it, or remove it from the capabilities");
	for (const { file, source } of steps) failures.push(...coverage("ios", file, phoneActions, swiftBranches(source, "action"), "step"));
	failures.push(...coverage("ios", "ios/AgentScreen/", keysFor("ios"), sources.flatMap(({ source }) => swiftBranches(source, "key")), "key"));
}
assert.deepEqual(keysFor("android"), PHONE_KEYS);
assert.deepEqual(keysFor("ios"), PHONE_KEYS.filter((key) => key !== "recents"));

const swiftExample = `switch action {
	case "tap", "long_press": run("decoy")
	case "key": switch key { case "enter": run() default: stop() }
	default: stop()
}`;
assert.deepEqual(swiftBranches(swiftExample, "action"), ["tap", "long_press", "key"]);
assert.deepEqual(swiftBranches(swiftExample, "key"), ["enter"]);
assert.equal(coverage("ios", "fixture.swift", ["tap", "scroll_to"], swiftBranches(swiftExample, "action"), "step").length, 3);
assert.deepEqual(swiftBranches('let prose = "case \\"tap\\": fake()"', "action"), []);
assert.deepEqual(kotlinSteps('val prose = "tap"', "ScreenStep"), []);

const kinds = When.anyOf.map((option) => String(option.properties.kind.const));
const scheduleKt = readFileSync(new URL(`../${NATIVE}Schedule.kt`, import.meta.url), "utf8");
const readable = new Set([...scheduleKt.matchAll(/"(\w+)" ->|kind == "(\w+)"/g)].map((match) => match[1] ?? match[2]));
const unread = kinds.filter((kind) => !readable.has(kind));
if (unread.length) failures.push(`schedule kinds in src/triggers/plugin.ts that When.of in ${NATIVE}Schedule.kt does not read: ${unread.join(", ")}; Android would drop the schedule without an error`);
const activityKt = readFileSync(new URL(`../${NATIVE}ActivityTrigger.kt`, import.meta.url), "utf8");
const watched = new Set([...activityKt.matchAll(/DetectedActivity\.\w+, "(\w+)"/g)].map((match) => match[1]));
const unwatched = ACTIVITIES.filter((activity) => !watched.has(activity));
if (unwatched.length) failures.push(`ACTIVITIES in src/triggers/plugin.ts that ${NATIVE}ActivityTrigger.kt does not watch: ${unwatched.join(", ")}`);

failures.push(...snapshotFailures(SNAPSHOT, current, "plugin", "its contract or iOS coverage"));
exitOnFailures(failures);
const total = current.reduce((sum, plugin) => sum + Object.keys(plugin.methods).length, 0);
const onIos = current.reduce((sum, plugin) => sum + plugin.ios.length, 0);
console.log(`plugins: ${current.length} contracts, ${total} methods, all on Android, ${onIos} on iOS`);
