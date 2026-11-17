export function isSource(href: string, label: string): boolean {
	if (!URL.canParse(href)) return false;
	const url = new URL(href);
	if (url.protocol !== "https:" && url.protocol !== "http:") return false;
	const name = label.trim().toLowerCase();
	return name !== "" && (url.hostname === name || url.hostname.split(".").slice(0, -1).includes(name));
}
