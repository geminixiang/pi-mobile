import { readdirSync } from "node:fs";
import type { Check } from "./setup.ts";

await import("./setup.ts");
const files = readdirSync(new URL(".", import.meta.url)).filter((file) => file.endsWith(".ts") && !["run.ts", "setup.ts", "fixtures.ts"].includes(file));
const suites: { file: string; checks: unknown }[] = await Promise.all(files.map(async (file) => ({ file, checks: (await import(`./${file}`)).checks })));
const unsuited = suites.filter((suite) => !Array.isArray(suite.checks)).map((suite) => suite.file);
if (unsuited.length > 0) {
	process.stderr.write(`contracts: ${unsuited.join(", ")} export no checks; a contract file exports \`checks\`, a helper goes next to setup.ts and fixtures.ts\n`);
	process.exit(1);
}
const only = process.argv[2];
const checks: Check[] = suites.flatMap((suite) => (Array.isArray(suite.checks) ? suite.checks : [])).filter(([name]) => !only || name.includes(only));
if (checks.length === 0) {
	process.stderr.write(`contracts: no check matches "${only}"\n`);
	process.exit(1);
}
const failures: string[] = [];
for (const [name, run] of checks) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("did not finish in 30 seconds")), 30_000);
	});
	try {
		await Promise.race([run(), timeout]);
	} catch (error) {
		failures.push(`${name}\n  ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	} finally {
		clearTimeout(timer);
	}
}
if (failures.length > 0) {
	process.stderr.write(`contracts: ${failures.length} of ${checks.length} failed\n${failures.join("\n")}\n`);
	process.exit(1);
}
process.stdout.write(`contracts: ${checks.length} hold\n`);
process.exit(0);
