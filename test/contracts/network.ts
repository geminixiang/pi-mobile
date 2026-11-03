import assert from "node:assert/strict";
import { DEFAULT_RETRY_POLICY } from "@earendil-works/pi-durable";
import { retryDelayMs } from "@earendil-works/pi-ai/utils/retry";
import { MODEL_RETRY } from "../../src/agent/retry.ts";
import type { Check } from "./setup.ts";

const OUTAGE_MS = 4 * 60_000;
const SLOWEST_RETRY_MS = 30_000;
const waits = (policy: typeof MODEL_RETRY) => Array.from({ length: policy.maxRetries }, (_, index) => retryDelayMs(policy, index + 1));

export const checks: Check[] = [
	[
		"a model answer cut off by a few minutes without a network is retried until the network is back, not failed after seconds",
		async () => {
			const total = waits(MODEL_RETRY).reduce((sum, wait) => sum + wait, 0);
			assert(total >= OUTAGE_MS, `retries cover ${Math.round(total / 1000)} s of outage; pi-durable's default covers ${Math.round(waits({ ...DEFAULT_RETRY_POLICY }).reduce((sum, wait) => sum + wait, 0) / 1000)} s`);
			assert(Math.max(...waits(MODEL_RETRY)) <= SLOWEST_RETRY_MS, "a retry waits so long that a network that is back sits idle");
		},
	],
];
