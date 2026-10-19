// Browser stand-ins for the node:crypto functions @earendil-works/pi-env imports.
import { Buffer } from "buffer";

export function randomBytes(size: number): Buffer {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(size)));
}

export function randomUUID(): string {
	return crypto.randomUUID();
}

export function createHash(): never {
	throw new Error("node:crypto createHash is not available in the app");
}
