import assert from "node:assert/strict";
import { Computers } from "../src/agent/computers.ts";
import type { Settings } from "../src/settings.ts";

const settings: Settings = {
	providers: "[]",
	providerKeys: {},
	providerOAuth: {},
	githubToken: "",
	gcloudCredential: "",
	gcloudProject: "",
	cloudflareCredential: "",
	azureCredential: "",
	defaultProvider: "",
	defaultModelId: "",
	defaultThinking: "low",
	calendarAccess: "",
	hosts: "",
	computer: "",
	compactAt: 256_000,
};

const checks: [string, () => Promise<void> | void][] = [];
const check = (name: string, run: () => Promise<void> | void) => checks.push([name, run]);

check("a bot whose computer was removed does not move to another computer", () => {
	const host = { id: "b.example", address: "b.example", name: "B", os: "linux", arch: "arm64", user: "fixture", home: "/home/fixture" };
	const computers = new Computers({ ...settings, hosts: JSON.stringify([host]), computer: "b.example:direct" }, {});
	assert.deepEqual(computers.resolve("a.example:container"), { kind: "missing", key: "a.example:container" });
	assert.equal(computers.sandboxAt(computers.resolve("a.example:container")), undefined);
	const inherited = computers.resolve(undefined);
	assert.equal(inherited.kind === "ready" && inherited.computer.key, "b.example:direct");
	const chosen = computers.resolve("phone");
	assert.equal(chosen.kind === "ready" && chosen.computer.key, "phone");
});

const failures: string[] = [];
for (const [name, run] of checks) {
	try {
		await run();
	} catch (error) {
		failures.push(`${name}\n  ${error instanceof Error ? error.message : String(error)}`);
	}
}
if (failures.length > 0) {
	console.error(`contracts: ${failures.length} of ${checks.length} failed\n${failures.join("\n")}`);
	process.exit(1);
}
console.log(`contracts: ${checks.length} hold`);
