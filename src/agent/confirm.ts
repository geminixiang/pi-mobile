// Bridge from tools to the UI: a tool asks, the UI shows a dialog, the tool continues with the answer.
// Without a UI listener (tests), every request is declined.
//
// Writes to one place (a GitHub repository, a cloud service) come in bursts: a push through the API is a blob per
// file, a tree, a commit, and a ref. The dialog can allow the rest of such a burst: "grant" approves this request and
// every request with the same grant key for GRANT_MS, without asking again.

export interface ConfirmRequest {
	title: string;
	detail: string;
}

/** What the UI is asked: the request, and the key a grant would cover, when this kind of request can be granted. */
export interface ConfirmPrompt extends ConfirmRequest {
	grant?: string;
}

type Listener = (request: ConfirmPrompt) => Promise<boolean | "grant">;

export const GRANT_MS = 10 * 60_000;

let listener: Listener | undefined;
const grants = new Map<string, number>();

export function setConfirmListener(next: Listener | undefined): void {
	listener = next;
}

/**
 * The place a write goes to, for a request that can be granted; undefined for those that are asked every time
 * (deletes, calendar events, schedules, replies, MCP tools). Titles come from the tools here and from the sandbox's
 * egress proxy (sandbox/egress/credentials.py).
 */
export function grantKey(title: string): string | undefined {
	const repo = /^GitHub (?!DELETE)[A-Z]+ \/repos\/([^/\s]+\/[^/\s?]+)/.exec(title) ?? /^git (?:lfs )?push (\S+)/.exec(title);
	if (repo?.[1]) return `GitHub ${repo[1].replace(/\.git$/, "")}`;
	if (/^GitHub GraphQL /.test(title)) return "GitHub GraphQL";
	if (/^GitHub [A-Z]+ /.test(title) && !/^GitHub DELETE /.test(title)) return "GitHub";
	const google = /^Google Cloud (?!DELETE)[A-Z]+ ([^\s/]+)/.exec(title);
	if (google) return `Google Cloud ${google[1]}`;
	const azure = /^Azure (?!DELETE)[A-Z]+ ([^\s/]+)/.exec(title);
	if (azure) return `Azure ${azure[1]}`;
	if (/^Cloudflare (?!DELETE)[A-Z]+ /.test(title)) return "Cloudflare";
	return undefined;
}

export async function requestConfirmation(request: ConfirmRequest): Promise<boolean> {
	if (!listener) return false;
	const key = grantKey(request.title);
	if (key && (grants.get(key) ?? 0) > Date.now()) return true;
	const answer = await listener(key ? { ...request, grant: key } : request);
	if (answer === "grant" && key) grants.set(key, Date.now() + GRANT_MS);
	return answer !== false;
}
