// pi-env and pi-mcp use the Buffer global; the WebView has none. The buffer package lacks the base64url encoding,
// which pi-mcp's OAuth (PKCE) uses: added here as base64 with the URL alphabet and no padding.
import { Buffer } from "buffer";

const toString = Buffer.prototype.toString;
Buffer.prototype.toString = function (this: Buffer, encoding?: string, start?: number, end?: number): string {
	if (encoding !== "base64url") return toString.call(this, encoding, start, end);
	return toString.call(this, "base64", start, end).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

if (!("Buffer" in globalThis)) Object.assign(globalThis, { Buffer });
