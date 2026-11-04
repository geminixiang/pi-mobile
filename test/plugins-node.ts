import { readdirSync, readFileSync } from "node:fs";
import type { Methods } from "../src/plugins/define.ts";
import { PLUGINS } from "../src/plugins/index.ts";
import { ACTIVITIES, When } from "../src/triggers/plugin.ts";
import { exitOnFailures, plain, snapshotFailures, sourcesMatching } from "./snapshot.ts";

const SNAPSHOT = new URL("./plugins.snapshot.json", import.meta.url);
const ANDROID = new URL("../android/app/src/main/java/dev/geminixiang/pimobile/", import.meta.url);
const IOS = new URL("../ios/App/App/", import.meta.url);
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

const android = scan(ANDROID, [".java", ".kt"], /@CapacitorPlugin\(\s*name\s*=\s*"(\w+)"/, (source) =>
	[...source.matchAll(/@PluginMethod(?:\([^)]*\))?(?:\s+@\w+(?:\([^)]*\))?)*\s+(?:public\s+void|fun)\s+(\w+)\s*\(/g)].flatMap((match) => (match[1] ? [match[1]] : [])),
);
const ios = scan(IOS, [".swift"], /jsName\s*=\s*"(\w+)"/, (source) => [...(/pluginMethods[^=]*=\s*\[([^\]]*)\]/s.exec(source)?.[1] ?? "").matchAll(/"(\w+)"/g)].flatMap((match) => (match[1] ? [match[1]] : [])));

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

for (const file of readdirSync(ANDROID).filter((name) => name.endsWith(".java") || name.endsWith(".kt"))) {
	if (/\bcall\.getLong\(/.test(readFileSync(new URL(file, ANDROID), "utf8"))) {
		failures.push(`${file} reads a number with call.getLong, which returns its default for any number that fits in an int; use call.getData().optLong`);
	}
}

for (const [name, methods] of ios) {
	if (methods.has("checkPermissions") && !methods.has("requestPermissions")) failures.push(`iOS ${name} reports permissions but cannot ask for them, so the permission card's 允許 does nothing: add requestPermissions to its pluginMethods`);
}

for (const file of readdirSync(ANDROID).filter((name) => name.endsWith(".java"))) {
	if (/^\s*\w+\.put\("\w+", cursor\.getString\(/m.test(readFileSync(new URL(file, ANDROID), "utf8"))) {
		failures.push(`${file} puts a cursor string straight into a result: a null removes the key, and one row then fails the whole list against its contract; use Objects.toString(value, "") or skip the key`);
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
const androidMissing = unregistered(ANDROID, [".java", ".kt"], (source) => /\bclass (\w+)/.exec(source.slice(source.search(/@CapacitorPlugin\(/)))?.[1], "MainActivity.java", /registerPlugin\((\w+)(?:\.class|::class\.java)\)/g);
if (androidMissing.length) failures.push(`Android plugins not registered in MainActivity.onCreate, so their tools vanish without an error: ${androidMissing.join(", ")}; add registerPlugin(X.class)`);
const iosMissing = unregistered(IOS, [".swift"], (source) => [...source.slice(0, Math.max(0, source.search(/jsName\s*=\s*"/))).matchAll(/class (\w+)/g)].at(-1)?.[1], "MainViewController.swift", /registerPluginInstance\((\w+)\(\)\)/g);
if (iosMissing.length) failures.push(`iOS plugins not registered in MainViewController.capacitorDidLoad: ${iosMissing.join(", ")}; add bridge?.registerPluginInstance(X())`);

const NATIVE = "android/app/src/main/java/dev/geminixiang/pimobile/";
const STEP_LISTS = [
	{ contract: "src/phone-screen/plugin.ts", native: "ScreenActor.kt" },
	{ contract: "src/browser/plugin.ts", native: "BrowserSteps.kt" },
];
for (const { contract, native } of STEP_LISTS) {
	const source = readFileSync(new URL(`../${contract}`, import.meta.url), "utf8");
	const names = [
		...[...source.matchAll(/action: Type\.Literal\("(\w+)"\)/g)].map((match) => match[1] ?? ""),
		...[...source.matchAll(/action: oneOf\(\[([^\]]*)\]\)/g)].flatMap((match) => [...(match[1] ?? "").matchAll(/"(\w+)"/g)].map((name) => name[1] ?? "")),
		...[...(/export const KEYS = \[([^\]]*)\]/.exec(source)?.[1] ?? "").matchAll(/"(\w+)"/g)].map((match) => match[1] ?? ""),
	];
	const kotlin = readFileSync(new URL(`../${NATIVE}${native}`, import.meta.url), "utf8");
	const unknown = names.filter((name) => !kotlin.includes(`"${name}"`));
	if (names.length === 0 || unknown.length > 0) failures.push(`step actions and keys in ${contract} that ${NATIVE}${native} does not read: ${unknown.join(", ") || "none found in the contract"}`);
}

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
