const bare = (hostname: string) => hostname.replace(/^\[|\]$/g, "").toLowerCase();

function octetsOf(host: string): number[] | undefined {
	const octets = host.split(".").map(Number);
	return octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) ? octets : undefined;
}

function inTailnet(host: string): boolean {
	if (host.endsWith(".ts.net") || host.startsWith("fd7a:115c:a1e0:")) return true;
	const [first, second = 0] = octetsOf(host) ?? [];
	return first === 100 && second >= 64 && second <= 127;
}

const loopback = (host: string) => host === "localhost" || host === "::1" || octetsOf(host)?.[0] === 127;

export function onTailnet(url: string): boolean {
	if (!URL.canParse(url)) return false;
	const host = bare(new URL(url).hostname);
	return inTailnet(host) || (!host.includes(".") && !host.includes(":") && host !== "localhost");
}

export const tailscaleHint = (ios: boolean) => (ios ? "；在 Tailscale app 開「VPN On Demand」，有網路就會自動連上" : "");

export function refuseCleartextSecret(url: string): void {
	if (!URL.canParse(url)) return;
	const parsed = new URL(url);
	const host = bare(parsed.hostname);
	if (parsed.protocol !== "http:" || inTailnet(host) || loopback(host)) return;
	throw new Error(`不透過明文 HTTP 把金鑰送到 ${parsed.host}：改用 https，或這台機器的 Tailscale 名稱（*.ts.net）`);
}

const IP_ADDRESS = /^\d{1,3}(\.\d{1,3}){3}$|:/;

export function refuseIpOnIos(url: string, ios: boolean): void {
	if (!ios || !URL.canParse(url)) return;
	const parsed = new URL(url);
	const host = bare(parsed.hostname);
	if (!["http:", "ws:"].includes(parsed.protocol) || !IP_ADDRESS.test(host) || host === "127.0.0.1" || host === "::1") return;
	throw new Error(`iPhone 和 iPad 不能用明文 HTTP 連 IP 位址（${parsed.host}）：改填這台機器的 Tailscale 名稱，例如 mac.xxxx.ts.net`);
}
