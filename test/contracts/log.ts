import assert from "node:assert/strict";
import { log, recentLog, saveLogWith } from "../../src/log.ts";
import type { Check } from "./setup.ts";

export const checks: Check[] = [
	[
		"every line reaches the device as soon as the current task ends, redacted, so a page that hangs has already saved what led up to it",
		async () => {
			log.info("contract.before_saving");
			const saved: string[][] = [];
			saveLogWith((lines) => void saved.push(lines));
			log.warn("contract.first", { text: "Bearer eyJhbGciOi.payload" });
			log.info("contract.second");
			await Promise.resolve();
			const lines = saved.flat().map((line) => JSON.parse(line));
			assert.ok(lines.some((line) => line.event === "contract.before_saving"), "what was logged before saving began is kept too");
			assert.equal(saved.length, 1, "one task is one native call");
			assert.deepEqual(lines.slice(-2).map((line) => line.event), ["contract.first", "contract.second"]);
			assert.equal(lines.at(-2).text, "[redacted]");
			log.info("contract.later");
			await Promise.resolve();
			assert.equal(saved.length, 2);
			saveLogWith(() => undefined);
		},
	],
	[
		"the recent log keeps timestamped lines with secrets redacted before they are written anywhere",
		async () => {
			log.warn("contract.secret", { text: "token ghp_abcdef0123456789 and Bearer eyJhbGciOi.payload, host b.example" });
			const lines = recentLog().trim().split("\n");
			const last = JSON.parse(lines.at(-1) ?? "{}");
			assert.equal(last.event, "contract.secret");
			assert.equal(last.level, "warn");
			assert.match(last.at, /^\d{4}-\d{2}-\d{2}T/);
			assert.equal(last.text, "token [redacted] and [redacted], host b.example");
		},
	],
	[
		"the recent log is bounded",
		async () => {
			for (let i = 0; i < 2500; i++) log.info("contract.fill", { i });
			const lines = recentLog().trim().split("\n");
			assert.equal(lines.length, 2000);
			assert.equal(JSON.parse(lines.at(-1) ?? "{}").i, 2499);
		},
	],
];
