import { Buffer } from "buffer";

const toString = Buffer.prototype.toString;
Buffer.prototype.toString = function (this: Buffer, encoding?: string, start?: number, end?: number): string {
	if (encoding !== "base64url") return toString.call(this, encoding, start, end);
	return toString.call(this, "base64", start, end).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

if (!("Buffer" in globalThis)) Object.assign(globalThis, { Buffer });
