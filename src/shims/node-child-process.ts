// Stand-in for node:child_process: pi-env's Connection spawns the daemon, which the app replaces with
// WebSocketConnection. Calling it in the app is a bug.
export function spawn(): never {
	throw new Error("node:child_process is not available in the app");
}
