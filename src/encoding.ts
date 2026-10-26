export function fromBase64(base64: string): Uint8Array<ArrayBuffer> {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
	return bytes;
}

export function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
	return btoa(binary);
}

export function toBase64Url(bytes: Uint8Array | ArrayBuffer): string {
	return toBase64(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomHex(bytes: number): string {
	return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}
