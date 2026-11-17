import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { TSchema } from "typebox";
import type { Methods } from "../src/plugins/define.ts";

export const updating = process.argv.includes("--update");

export function plain(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(plain);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([, inner]) => typeof inner !== "function")
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, inner]) => [key, plain(inner)]),
	);
}

export function sourcesMatching(pattern: RegExp, except: readonly string[] = []): string[] {
	return readdirSync(new URL("../src", import.meta.url), { recursive: true, encoding: "utf8" }).filter(
		(file) => /\.tsx?$/.test(file) && !except.includes(file) && pattern.test(readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8")),
	);
}

interface NativeContract {
	readonly name: string;
	readonly contract: { readonly methods: Methods; readonly events: Readonly<Record<string, TSchema>> };
}

const isContract = (value: unknown): value is NativeContract => typeof value === "object" && value !== null && typeof Reflect.get(value, "name") === "string" && typeof Reflect.get(value, "contract") === "object";

export async function nativeContracts(): Promise<NativeContract[]> {
	const modules: object[] = await Promise.all(sourcesMatching(/\bdefinePlugin\(/, ["plugins/define.ts"]).map((file) => import(`../src/${file}`)));
	return modules.flatMap((module) => Object.values(module).filter(isContract)).sort((a, b) => a.name.localeCompare(b.name));
}

const nameOf = (item: unknown): string | undefined => {
	const name: unknown = typeof item === "object" && item !== null ? Reflect.get(item, "name") : undefined;
	return typeof name === "string" ? name : undefined;
};

export function snapshotFailures(file: URL, current: readonly { name: string }[], noun: string, change: string): string[] {
	if (updating) {
		writeFileSync(file, `${JSON.stringify(current, null, "\t")}\n`);
		return [];
	}
	if (!existsSync(file)) return [`no ${file.pathname.split("/").at(-1)}; run with --update to create it`];
	const saved: unknown = JSON.parse(readFileSync(file, "utf8"));
	const before = new Map((Array.isArray(saved) ? saved : []).flatMap((item: unknown) => [[nameOf(item), JSON.stringify(item)] as const]));
	const failures = current.flatMap((item) => {
		const was = before.get(item.name);
		before.delete(item.name);
		if (was === undefined) return [`new ${noun} ${item.name}: add it to the snapshot (--update) and to docs/tools.md`];
		return was === JSON.stringify(item) ? [] : [`${item.name} changed ${change}; if intended, --update and note it in docs/tools.md`];
	});
	return [...failures, ...[...before.keys()].map((name) => `${noun} ${name} is gone; if intended, --update and note it in docs/tools.md`)];
}

export function exitOnFailures(failures: readonly string[]): void {
	if (failures.length === 0) return;
	console.error(failures.map((failure) => `✖ ${failure}`).join("\n"));
	process.exit(1);
}
