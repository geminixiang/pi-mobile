import type { ConversationRetryPolicy } from "@earendil-works/pi-durable";

export const MODEL_RETRY: ConversationRetryPolicy = { enabled: true, maxRetries: 12, baseDelayMs: 2000, maxAgentDelayMs: 30_000 };
