import { readdirSync, readFileSync } from "node:fs";

const NOT_A_CHECK: Record<string, string> = {
	"test/snapshot.ts": "helper for the snapshot checks",
	"test/bash/run.ts": "runs on a phone over DevTools",
};

const scripts = Object.values(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts).join(" ");
const tests = ["test", "test/bash"].flatMap((directory) =>
	readdirSync(new URL(`../${directory}/`, import.meta.url))
		.filter((file) => file.endsWith(".ts"))
		.map((file) => `${directory}/${file}`),
);
const missing = tests.filter((test) => !(test in NOT_A_CHECK) && !scripts.includes(test));
if (missing.length > 0) {
	console.error(`registered: ${missing.join(", ")} never run; add each to the check script in package.json, or to NOT_A_CHECK in test/registered.ts with the reason`);
	process.exit(1);
}
console.log(`registered: ${tests.length - Object.keys(NOT_A_CHECK).length} test files run in npm run check`);
