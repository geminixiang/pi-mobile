import type { Plugin } from "vite";

const MODULE = /node_modules\/@earendil-works\/pi-ai\/dist\/api\/openai-codex-responses\.js$/;

type Patch = { name: string; find: string; replace: string };

const KEY_IN_QUERY = `
function withKeyInQuery(url, authorization) {
    if (!authorization?.startsWith("Bearer ")) return url;
    const keyed = new URL(url);
    keyed.searchParams.set("key", authorization.slice("Bearer ".length));
    return keyed.toString();
}
`;

const PATCHES: Patch[] = [
	{
		name: "a plain API key has no ChatGPT account id",
		find: `throw new Error("Failed to extract accountId from token");`,
		replace: `return undefined;`,
	},
	{
		name: "the account header goes out only with an account id",
		find: `headers.set("chatgpt-account-id", accountId);`,
		replace: `if (accountId) headers.set("chatgpt-account-id", accountId);`,
	},
	{
		name: "a browser WebSocket takes no headers, so the key goes in ?key=",
		find: `socket = new WebSocketCtor(url, { headers: wsHeaders });`,
		replace: `socket = new WebSocketCtor(withKeyInQuery(url, wsHeaders.authorization));`,
	},
];

export function patchCodexResponses(source: string): string {
	const patched = PATCHES.reduce((text, patch) => {
		if (text.split(patch.find).length !== 2) {
			throw new Error(`pi-ai's openai-codex-responses.js no longer has the code for "${patch.name}" exactly once; recheck vite-plugins/pi-ai-codex.ts against the new pi-ai`);
		}
		return text.replace(patch.find, patch.replace);
	}, source);
	return `${patched}${KEY_IN_QUERY}`;
}

export function codexInWebView(): Plugin {
	return {
		name: "pi-ai-codex-in-webview",
		enforce: "pre",
		transform(code, id) {
			return MODULE.test(id) ? patchCodexResponses(code) : undefined;
		},
	};
}
