const HTML_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:">`;

export function withCsp(html: string): string {
	const head = /<head(\s[^>]*)?>/i.exec(html);
	return head ? `${html.slice(0, head.index + head[0].length)}${HTML_CSP}${html.slice(head.index + head[0].length)}` : `${HTML_CSP}${html}`;
}
