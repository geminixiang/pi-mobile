import type { CheckpointInfo } from "@earendil-works/pi-durable";

export const checkpointEvery64 = (_value: unknown, _ops: unknown, info: CheckpointInfo): boolean => info.deltasSinceBase >= 64;
