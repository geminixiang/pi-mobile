function tailnetOrLoopback(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (host === "localhost" || host === "::1" || host.endsWith(".ts.net")) return true;
	if (host.startsWith("fd7a:115c:a1e0:")) return true;
	const octets = host.split(".").map(Number);
	if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
	const [first = 0, second = 0] = octets;
	return first === 127 || (first === 100 && second >= 64 && second <= 127);
}

export function refuseCleartextSecret(url: string): void {
	if (!URL.canParse(url)) return;
	const parsed = new URL(url);
	if (parsed.protocol !== "http:" || tailnetOrLoopback(parsed.hostname)) return;
	throw new Error(`不透過明文 HTTP 把金鑰送到 ${parsed.host}：改用 https，或這台機器的 Tailscale 名稱（*.ts.net）`);
}

const IP_ADDRESS = /^\d{1,3}(\.\d{1,3}){3}$|:/;

export function refuseIpOnIos(url: string, ios: boolean): void {
	if (!ios || !URL.canParse(url)) return;
	const parsed = new URL(url);
	const host = parsed.hostname.replace(/^\[|\]$/g, "");
	if (!["http:", "ws:"].includes(parsed.protocol) || !IP_ADDRESS.test(host) || host === "127.0.0.1" || host === "::1") return;
	throw new Error(`iPhone 和 iPad 不能用明文 HTTP 連 IP 位址（${parsed.host}）：改填這台機器的 Tailscale 名稱，例如 mac.xxxx.ts.net`);
}
