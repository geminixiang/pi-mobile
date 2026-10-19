// Browser stand-in for node:url's fileURLToPath (POSIX file URLs only).
export function fileURLToPath(url: string | URL): string {
	const parsed = typeof url === "string" ? new URL(url) : url;
	if (parsed.protocol !== "file:") throw new TypeError("The URL must be of scheme file");
	return decodeURIComponent(parsed.pathname);
}
