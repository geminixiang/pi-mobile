export const TEMP_FOLDER = ".tmp";

export function normalizePath(path: string): string {
	const parts: string[] = [];
	for (const part of path.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") parts.pop();
		else parts.push(part);
	}
	return `/${parts.join("/")}`;
}

export function resolvePath(base: string, path: string): string {
	return normalizePath(path.startsWith("/") ? path : `${base}/${path}`);
}

export type FsOp =
	| { op: "stat"; path: string }
	| { op: "exists"; path: string }
	| { op: "create"; path: string; directory: boolean }
	| { op: "chmod"; path: string; mode: number }
	| { op: "list"; path: string }
	| { op: "readText"; path: string }
	| { op: "readBytes"; path: string }
	| { op: "write"; path: string; content: string | Uint8Array; append: boolean }
	| { op: "mkdir"; path: string; recursive: boolean }
	| { op: "remove"; path: string; recursive: boolean; force: boolean }
	| { op: "rename"; from: string; to: string };

export type FsValue = boolean | { kind: "file" | "directory"; size: number; mtimeMs: number; executable: boolean } | { name: string; kind: "file" | "directory" }[] | string | Uint8Array | null;

export type HttpRequest = { url: string; method: string; headers: Record<string, string>; body?: Uint8Array<ArrayBuffer> };
export type HttpResponse = { status: number; headers: Record<string, string>; body: Uint8Array<ArrayBuffer> };

export type ToWorker =
	| { type: "exec"; exec: number; bot: string; command: string; cwd: string; env: Record<string, string> }
	| { type: "abort"; exec: number }
	| { type: "fs-reply"; call: number; ok: true; value: FsValue }
	| { type: "fs-reply"; call: number; ok: false; code: string; message: string }
	| { type: "http-reply"; call: number; ok: true; response: HttpResponse }
	| { type: "http-reply"; call: number; ok: false; message: string };

export type FromWorker =
	| { type: "fs"; call: number; bot: string; request: FsOp }
	| { type: "http"; call: number; exec: number; request: HttpRequest }
	| { type: "done"; exec: number; stdout: string; stderr: string; exitCode: number }
	| { type: "failed"; exec: number; message: string };
