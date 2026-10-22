// Messages between the main thread and the bash worker (shell-worker.ts). The worker runs just-bash; every file
// operation it makes comes back here, because only the main thread reaches the native plugin that holds the files.

/** A file operation on a bot's folder; paths are relative to it ("" is the folder). */
export type FsOp =
	| { op: "stat"; path: string }
	| { op: "list"; path: string }
	| { op: "readText"; path: string }
	| { op: "readBytes"; path: string }
	| { op: "write"; path: string; content: string | Uint8Array; append: boolean }
	| { op: "mkdir"; path: string; recursive: boolean }
	| { op: "remove"; path: string; recursive: boolean; force: boolean }
	| { op: "rename"; from: string; to: string };

export type FsValue = { kind: "file" | "directory"; size: number; mtimeMs: number } | { name: string; kind: "file" | "directory" }[] | string | Uint8Array | null;

export type ToWorker =
	| { type: "exec"; exec: number; bot: string; command: string; cwd: string; env: Record<string, string> }
	| { type: "abort"; exec: number }
	| { type: "fs-reply"; call: number; ok: true; value: FsValue }
	| { type: "fs-reply"; call: number; ok: false; code: string; message: string };

export type FromWorker =
	| { type: "fs"; call: number; bot: string; request: FsOp }
	| { type: "done"; exec: number; stdout: string; stderr: string; exitCode: number }
	| { type: "failed"; exec: number; message: string };
