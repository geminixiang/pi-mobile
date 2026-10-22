// When the app's own documents (bots, memory, triggers) store a change as a complete value instead of a delta:
// every 64 deltas, as pi-durable's own documents do, so reading one replays a bounded number of changes.
import type { CheckpointInfo } from "@earendil-works/pi-durable";

export const checkpointEvery64 = (_value: unknown, _ops: unknown, info: CheckpointInfo): boolean => info.deltasSinceBase >= 64;
