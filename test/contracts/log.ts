import assert from "node:assert/strict";
import { log, recentLog } from "../../src/log.ts";
import type { Check } from "./setup.ts";

export const checks: Check[] = [
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
