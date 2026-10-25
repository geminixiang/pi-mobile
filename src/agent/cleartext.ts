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
	throw new Error(`不透過明文 HTTP 把金鑰送到 ${parsed.host}：改用 https，或這台機器的 Tailscale 名稱（*.ts.net）或 100.x 位址`);
}
