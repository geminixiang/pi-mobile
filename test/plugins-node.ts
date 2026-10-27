import { readdirSync, readFileSync } from "node:fs";
import type { Methods } from "../src/plugins/define.ts";
import { PLUGINS } from "../src/plugins/index.ts";
import { exitOnFailures, plain, snapshotFailures, sourcesMatching } from "./snapshot.ts";

const SNAPSHOT = new URL("./plugins.snapshot.json", import.meta.url);
const ANDROID = new URL("../android/app/src/main/java/dev/geminixiang/pimobile/", import.meta.url);
const IOS = new URL("../ios/App/App/", import.meta.url);
const INHERITED_ON_ANDROID = new Set(["checkPermissions", "requestPermissions"]);

function scan(directory: URL, extension: string, plugin: RegExp, methods: (source: string) => string[]): Map<string, Set<string>> {
	const found = new Map<string, Set<string>>();
	for (const file of readdirSync(directory).filter((name) => name.endsWith(extension))) {
		const source = readFileSync(new URL(file, directory), "utf8");
		const name = plugin.exec(source)?.[1];
		if (name) found.set(name, new Set(methods(source)));
	}
	return found;
}

const android = scan(ANDROID, ".java", /@CapacitorPlugin\(\s*name\s*=\s*"(\w+)"/, (source) =>
	[...source.matchAll(/@PluginMethod(?:\([^)]*\))?(?:\s+@\w+(?:\([^)]*\))?)*\s+public\s+void\s+(\w+)\s*\(/g)].flatMap((match) => (match[1] ? [match[1]] : [])),
);
const ios = scan(IOS, ".swift", /jsName\s*=\s*"(\w+)"/, (source) => [...(/pluginMethods[^=]*=\s*\[([^\]]*)\]/s.exec(source)?.[1] ?? "").matchAll(/"(\w+)"/g)].flatMap((match) => (match[1] ? [match[1]] : [])));

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

for (const file of readdirSync(ANDROID).filter((name) => name.endsWith(".java"))) {
	if (/\bcall\.getLong\(/.test(readFileSync(new URL(file, ANDROID), "utf8"))) {
		failures.push(`${file} reads a number with call.getLong, which returns its default for any number that fits in an int; use call.getData().optLong`);
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

failures.push(...snapshotFailures(SNAPSHOT, current, "plugin", "its contract or iOS coverage"));
exitOnFailures(failures);
const total = current.reduce((sum, plugin) => sum + Object.keys(plugin.methods).length, 0);
const onIos = current.reduce((sum, plugin) => sum + plugin.ios.length, 0);
console.log(`plugins: ${current.length} contracts, ${total} methods, all on Android, ${onIos} on iOS`);
