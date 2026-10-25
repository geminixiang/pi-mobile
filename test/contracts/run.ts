import type { Check } from "./setup.ts";

await import("./setup.ts");
const suites: { checks: Check[] }[] = [await import("./computers.ts"), await import("./mcp.ts"), await import("./stream.ts"), await import("./where.ts"), await import("./cleartext.ts"), await import("./storage.ts"), await import("./triggers.ts"), await import("./bots.ts"), await import("./log.ts")];
const only = process.argv[2];
const checks = suites.flatMap((suite) => suite.checks).filter(([name]) => !only || name.includes(only));
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
