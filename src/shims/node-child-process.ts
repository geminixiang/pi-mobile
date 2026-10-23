export function spawn(): never {
	throw new Error("node:child_process is not available in the app");
}
