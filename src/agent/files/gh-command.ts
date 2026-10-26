import { type Command, defineCommand, type ExecResult, type ResolvedCommandContext } from "just-bash/browser";
import type { FolderFetch } from "./folder-fetch.ts";
import { jsonOrText } from "../parse.ts";
import { shellQuote } from "../../shell.ts";

const API = "https://api.github.com";
const DEFAULT_LIMIT = 30;

type Ctx = ResolvedCommandContext;
type Repo = { owner: string; name: string };
type Flags = { positional: string[]; values: Map<string, string[]>; set: Set<string> };

class GhError extends Error {}

const ok = (stdout: string): ExecResult => ({ stdout, stderr: "", exitCode: 0 });
const failed = (message: string): ExecResult => ({ stdout: "", stderr: `${message}\n`, exitCode: 1 });

function parseFlags(args: readonly string[], withValue: Record<string, string>, boolean: Record<string, string>): Flags {
	const flags: Flags = { positional: [], values: new Map(), set: new Set() };
	for (let at = 0; at < args.length; at++) {
		const arg = args[at] ?? "";
		if (arg === "--") {
			flags.positional.push(...args.slice(at + 1));
			break;
		}
		const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
		const name = equals > 0 ? arg.slice(0, equals) : arg;
		const valueName = withValue[name];
		if (valueName) {
			const value = equals > 0 ? arg.slice(equals + 1) : args[++at];
			if (value === undefined) throw new GhError(`flag needs an argument: ${name}`);
			flags.values.set(valueName, [...(flags.values.get(valueName) ?? []), value]);
		} else if (boolean[name]) {
			flags.set.add(boolean[name]);
		} else if (arg.startsWith("-") && arg !== "-") {
			throw new GhError(`unknown flag: ${arg}\nThis gh supports common flags only; use \`gh api\` for anything else.`);
		} else {
			flags.positional.push(arg);
		}
	}
	return flags;
}

const one = (flags: Flags, name: string) => flags.values.get(name)?.at(-1);

function at(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

const text = (value: unknown) => (typeof value === "string" ? value : value === null || value === undefined ? "" : String(value));

const apiMessage = (body: string) => text(at(jsonOrText(body), "message"));

function parseRepo(spec: string): Repo | undefined {
	const match = /(?:github\.com[/:])?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(spec.trim());
	return match?.[1] && match[2] ? { owner: match[1], name: match[2] } : undefined;
}

async function currentRepo(ctx: Ctx, flags: Flags): Promise<Repo> {
	const spec = one(flags, "repo") ?? ctx.env.get("GH_REPO");
	if (spec) {
		const repo = parseRepo(spec);
		if (!repo) throw new GhError(`expected OWNER/REPO, got ${spec}`);
		return repo;
	}
	const remote = await ctx.exec?.("git remote get-url origin", { cwd: ctx.cwd });
	const repo = remote && remote.exitCode === 0 ? parseRepo(remote.stdout) : undefined;
	if (!repo) throw new GhError("not in a GitHub repository: run it inside a clone, or pass -R OWNER/REPO");
	return repo;
}

async function currentBranch(ctx: Ctx): Promise<string> {
	const result = await ctx.exec?.("git branch --show-current", { cwd: ctx.cwd });
	const branch = result?.stdout.trim();
	if (!branch) throw new GhError("could not tell the current branch; pass it explicitly");
	return branch;
}

class Api {
	readonly #fetch: FolderFetch;
	constructor(fetch: FolderFetch) {
		this.#fetch = fetch;
	}

	async raw(method: string, path: string, body?: unknown, accept = "application/vnd.github+json", extra: Record<string, string> = {}) {
		const url = path.startsWith("https://") ? path : `${API}${path.startsWith("/") ? path : `/${path}`}`;
		const response = await this.#fetch(url, {
			method,
			headers: { Accept: accept, "X-GitHub-Api-Version": "2022-11-28", ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...extra },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		return { status: response.status, ok: response.ok, link: response.headers.get("link") ?? "", text: await response.text() };
	}

	async json(method: string, path: string, body?: unknown): Promise<unknown> {
		const response = await this.raw(method, path, body);
		if (!response.ok) throw new GhError(`${apiMessage(response.text) || response.text.slice(0, 200)} (HTTP ${response.status})`);
		return response.text ? jsonOrText(response.text) : null;
	}
}

function nextPage(link: string): string | undefined {
	return /<([^>]+)>;\s*rel="next"/.exec(link)?.[1];
}

const ITEM_FIELDS = ["number", "title", "state", "url", "body", "author", "createdAt", "updatedAt", "closedAt", "labels", "assignees", "headRefName", "baseRefName", "isDraft", "mergedAt"];

function itemField(item: unknown, field: string): unknown {
	switch (field) {
		case "number":
			return at(item, "number");
		case "title":
		case "body":
			return text(at(item, field));
		case "state":
			return at(item, "merged_at") ? "MERGED" : text(at(item, "state")).toUpperCase();
		case "url":
			return at(item, "html_url");
		case "author":
			return { login: at(at(item, "user"), "login") };
		case "createdAt":
		case "updatedAt":
		case "closedAt":
		case "mergedAt":
			return at(item, field.replace(/At$/, "_at")) ?? null;
		case "labels": {
			const labels = at(item, "labels");
			return Array.isArray(labels) ? labels.map((label) => ({ name: at(label, "name") })) : [];
		}
		case "assignees": {
			const people = at(item, "assignees");
			return Array.isArray(people) ? people.map((person) => ({ login: at(person, "login") })) : [];
		}
		case "headRefName":
			return at(at(item, "head"), "ref") ?? null;
		case "baseRefName":
			return at(at(item, "base"), "ref") ?? null;
		case "isDraft":
			return at(item, "draft") === true;
		case "repository":
			return { nameWithOwner: text(at(item, "repository_url")).replace(`${API}/repos/`, "") };
	}
	return undefined;
}

async function present(ctx: Ctx, flags: Flags, value: unknown, fields: readonly string[], plain: () => string): Promise<ExecResult> {
	const asked = one(flags, "json");
	if (asked === undefined) {
		if (flags.values.has("jq")) throw new GhError("--jq needs --json FIELDS");
		return ok(plain());
	}
	const wanted = asked.split(",").map((field) => field.trim()).filter(Boolean);
	const unknown = wanted.filter((field) => !fields.includes(field));
	if (wanted.length === 0 || unknown.length > 0) throw new GhError(`${unknown.length > 0 ? `Unknown JSON field: ${unknown.join(", ")}\n` : ""}Available fields:\n  ${fields.join("\n  ")}`);
	const pick = (item: unknown) => Object.fromEntries(wanted.map((field) => [field, itemField(item, field)]));
	const json = JSON.stringify(Array.isArray(value) ? value.map(pick) : pick(value), null, 2);
	return filter(ctx, flags, json);
}

async function filter(ctx: Ctx, flags: Flags, json: string): Promise<ExecResult> {
	const expression = one(flags, "jq");
	if (expression === undefined) return ok(`${json}\n`);
	const result = await ctx.exec?.(`jq -r ${shellQuote(expression)}`, { cwd: ctx.cwd, stdin: json });
	return result ?? failed("jq is not available");
}

function row(item: unknown, kind: "pr" | "issue"): string {
	const cells = [text(at(item, "number")), text(at(item, "title")), kind === "pr" ? text(at(at(item, "head"), "ref")) : "", text(itemField(item, "state")), text(at(item, "created_at"))];
	return (kind === "pr" ? cells : cells.filter((_, index) => index !== 2)).join("\t");
}

function detail(item: unknown, comments: readonly unknown[]): string {
	const lines = [
		`title:\t${text(at(item, "title"))}`,
		`state:\t${text(itemField(item, "state"))}`,
		`author:\t${text(at(at(item, "user"), "login"))}`,
		`url:\t${text(at(item, "html_url"))}`,
	];
	const head = at(at(item, "head"), "ref");
	if (head) lines.push(`branch:\t${text(head)} -> ${text(at(at(item, "base"), "ref"))}`);
	lines.push("--", text(at(item, "body")));
	for (const comment of comments) lines.push("--", `${text(at(at(comment, "user"), "login"))} (${text(at(comment, "created_at"))}):`, text(at(comment, "body")));
	return `${lines.join("\n")}\n`;
}

async function readBody(ctx: Ctx, flags: Flags): Promise<string | undefined> {
	const file = one(flags, "bodyFile");
	if (file === undefined) return one(flags, "body");
	if (file === "-") return ctx.stdin.toString();
	return ctx.fs.readFile(file.startsWith("/") ? file : `${ctx.cwd}/${file}`);
}

async function list(api: Api, path: string, limit: number, keep: (item: unknown) => boolean): Promise<unknown[]> {
	const items: unknown[] = [];
	let next: string | undefined = `${path}${path.includes("?") ? "&" : "?"}per_page=${Math.min(100, Math.max(limit, 1))}`;
	while (next && items.length < limit) {
		const page = await api.raw("GET", next);
		if (!page.ok) throw new GhError(`${apiMessage(page.text)} (HTTP ${page.status})`);
		const parsed = jsonOrText(page.text);
		if (!Array.isArray(parsed)) break;
		items.push(...parsed.filter(keep));
		next = nextPage(page.link);
	}
	return items.slice(0, limit);
}

const LIST_FLAGS = { "--search": "search", "-S": "search", "--state": "state", "-s": "state", "--limit": "limit", "-L": "limit", "--author": "author", "-A": "author", "--label": "label", "-l": "label", "--assignee": "assignee", "-a": "assignee", "--base": "base", "-B": "base", "--head": "head", "-H": "head", "--json": "json", "--jq": "jq", "-q": "jq", "--repo": "repo", "-R": "repo" };
const VIEW_FLAGS = { "--json": "json", "--jq": "jq", "-q": "jq", "--repo": "repo", "-R": "repo" };
const WRITE_FLAGS = { "--title": "title", "-t": "title", "--body": "body", "-b": "body", "--body-file": "bodyFile", "-F": "bodyFile", "--base": "base", "-B": "base", "--head": "head", "-H": "head", "--label": "label", "-l": "label", "--assignee": "assignee", "-a": "assignee", "--repo": "repo", "-R": "repo" };

async function itemNumber(api: Api, ctx: Ctx, repo: Repo, given: string | undefined): Promise<number> {
	if (given && /^#?\d+$/.test(given)) return Number(given.replace("#", ""));
	if (given && /\/(pull|issues)\/(\d+)/.test(given)) return Number(/\/(?:pull|issues)\/(\d+)/.exec(given)?.[1]);
	const branch = given ?? (await currentBranch(ctx));
	const found = await api.json("GET", `/repos/${repo.owner}/${repo.name}/pulls?state=all&head=${encodeURIComponent(`${repo.owner}:${branch}`)}`);
	const number = Array.isArray(found) ? at(found[0], "number") : undefined;
	if (typeof number !== "number") throw new GhError(`no pull request found for branch "${branch}"`);
	return number;
}

async function items(kind: "pr" | "issue", args: string[], ctx: Ctx, api: Api): Promise<ExecResult> {
	const [action = "", ...rest] = args;
	const base = (repo: Repo) => `/repos/${repo.owner}/${repo.name}`;
	const plural = kind === "pr" ? "pulls" : "issues";
	const numberOf = async (repo: Repo, given: string | undefined) => (kind === "pr" ? itemNumber(api, ctx, repo, given) : Number((given ?? "").replace("#", "")));
	switch (action) {
		case "list": {
			const flags = parseFlags(rest, LIST_FLAGS, {});
			const repo = await currentRepo(ctx, flags);
			const state = one(flags, "state") ?? "open";
			const query = new URLSearchParams({ state: state === "merged" ? "closed" : state });
			const label = one(flags, "label");
			const assignee = one(flags, "assignee");
			const baseRef = one(flags, "base");
			const headRef = one(flags, "head");
			if (kind === "issue" && label) query.set("labels", label);
			if (kind === "issue" && assignee) query.set("assignee", assignee);
			if (kind === "pr" && baseRef) query.set("base", baseRef);
			if (kind === "pr" && headRef) query.set("head", headRef.includes(":") ? headRef : `${repo.owner}:${headRef}`);
			const author = one(flags, "author");
			const search = one(flags, "search");
			if (search !== undefined) {
				const limit = Number(one(flags, "limit") ?? DEFAULT_LIMIT);
				const terms = [`repo:${repo.owner}/${repo.name}`, kind === "pr" ? "is:pr" : "is:issue", state === "all" ? "" : state === "merged" ? "is:merged" : `is:${state}`, author ? `author:${author}` : "", search];
				const result = await api.json("GET", `/search/issues?per_page=${Math.min(100, limit)}&q=${encodeURIComponent(terms.filter(Boolean).join(" "))}`);
				const matches = at(result, "items");
				const found = (Array.isArray(matches) ? matches : []).slice(0, limit);
				return present(ctx, flags, found, ITEM_FIELDS, () => found.map((item) => `${row(item, kind)}\n`).join(""));
			}
			const found = await list(api, `${base(repo)}/${plural}?${query}`, Number(one(flags, "limit") ?? DEFAULT_LIMIT), (item) =>
				(kind === "pr" || at(item, "pull_request") === undefined) &&
				(state !== "merged" || Boolean(at(item, "merged_at"))) &&
				(!author || at(at(item, "user"), "login") === author),
			);
			return present(ctx, flags, found, ITEM_FIELDS, () => found.map((item) => `${row(item, kind)}\n`).join(""));
		}
		case "view": {
			const flags = parseFlags(rest, VIEW_FLAGS, { "--comments": "comments", "-c": "comments" });
			const repo = await currentRepo(ctx, flags);
			const number = await numberOf(repo, flags.positional[0]);
			if (!number) throw new GhError("which issue? pass its number");
			const [item, comments] = await Promise.all([
				api.json("GET", `${base(repo)}/${plural}/${number}`),
				flags.set.has("comments") ? list(api, `${base(repo)}/issues/${number}/comments`, 100, () => true) : [],
			]);
			return present(ctx, flags, item, ITEM_FIELDS, () => detail(item, comments));
		}
		case "create": {
			const flags = parseFlags(rest, WRITE_FLAGS, { "--draft": "draft", "-d": "draft" });
			const repo = await currentRepo(ctx, flags);
			const title = one(flags, "title");
			if (!title) throw new GhError("--title is required");
			const body = (await readBody(ctx, flags)) ?? "";
			if (kind === "issue") {
				const created = await api.json("POST", `${base(repo)}/issues`, { title, body, labels: flags.values.get("label") ?? [], assignees: flags.values.get("assignee") ?? [] });
				return ok(`${text(at(created, "html_url"))}\n`);
			}
			const head = one(flags, "head") ?? (await currentBranch(ctx));
			const baseRef = one(flags, "base") ?? text(at(await api.json("GET", base(repo)), "default_branch"));
			const created = await api.json("POST", `${base(repo)}/pulls`, { title, body, head, base: baseRef, draft: flags.set.has("draft") });
			return ok(`${text(at(created, "html_url"))}\n`);
		}
		case "comment": {
			const flags = parseFlags(rest, WRITE_FLAGS, {});
			const repo = await currentRepo(ctx, flags);
			const number = await numberOf(repo, flags.positional[0]);
			const body = await readBody(ctx, flags);
			if (!number || !body) throw new GhError("usage: gh " + kind + " comment NUMBER --body TEXT");
			const created = await api.json("POST", `${base(repo)}/issues/${number}/comments`, { body });
			return ok(`${text(at(created, "html_url"))}\n`);
		}
		case "close":
		case "reopen": {
			const flags = parseFlags(rest, VIEW_FLAGS, {});
			const repo = await currentRepo(ctx, flags);
			const number = await numberOf(repo, flags.positional[0]);
			if (!number) throw new GhError(`usage: gh ${kind} ${action} NUMBER`);
			await api.json("PATCH", `${base(repo)}/${plural}/${number}`, { state: action === "close" ? "closed" : "open" });
			return ok(`${action === "close" ? "Closed" : "Reopened"} ${kind === "pr" ? "pull request" : "issue"} #${number}\n`);
		}
	}
	if (kind === "pr") return pullOnly(action, rest, ctx, api);
	throw new GhError(`unknown command "issue ${action}"; supported: list, view, create, comment, close, reopen. Use \`gh api\` for anything else.`);
}

const PULL_ONLY = new Set(["diff", "checkout", "merge"]);

async function pullOnly(action: string, rest: string[], ctx: Ctx, api: Api): Promise<ExecResult> {
	if (!PULL_ONLY.has(action)) throw new GhError(`unknown command "pr ${action}"; supported: list, view, create, diff, checkout, comment, merge, close, reopen. Use \`gh api\` for anything else.`);
	const flags = parseFlags(rest, VIEW_FLAGS, { "--merge": "merge", "-m": "merge", "--squash": "squash", "-s": "squash", "--rebase": "rebase", "-r": "rebase" });
	const repo = await currentRepo(ctx, flags);
	const number = await itemNumber(api, ctx, repo, flags.positional[0]);
	const path = `/repos/${repo.owner}/${repo.name}/pulls/${number}`;
	switch (action) {
		case "diff": {
			const response = await api.raw("GET", path, undefined, "application/vnd.github.diff");
			if (!response.ok) throw new GhError(`could not get the diff (HTTP ${response.status})`);
			return ok(response.text);
		}
		case "checkout": {
			const pull = await api.json("GET", path);
			const branch = text(at(at(pull, "head"), "ref"));
			const result = await ctx.exec?.(`git fetch origin ${shellQuote(`pull/${number}/head:${branch}`)} && git checkout ${shellQuote(branch)}`, { cwd: ctx.cwd });
			return result ?? failed("git is not available");
		}
		case "merge": {
			const method = flags.set.has("squash") ? "squash" : flags.set.has("rebase") ? "rebase" : "merge";
			const merged = await api.json("PUT", `${path}/merge`, { merge_method: method });
			return ok(`${text(at(merged, "message")) || "Merged"} #${number}\n`);
		}
	}
	throw new GhError(`unknown command "pr ${action}"; supported: list, view, create, diff, checkout, comment, merge, close, reopen. Use \`gh api\` for anything else.`);
}

function typedField(raw: string): unknown {
	if (raw === "true") return true;
	if (raw === "false") return false;
	if (raw === "null") return null;
	if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
	return raw;
}

async function api(args: string[], ctx: Ctx, client: Api): Promise<ExecResult> {
	const flags = parseFlags(
		args,
		{ "--method": "method", "-X": "method", "--raw-field": "raw", "-f": "raw", "--field": "field", "-F": "field", "--header": "header", "-H": "header", "--jq": "jq", "-q": "jq", "--input": "input" },
		{ "--paginate": "paginate", "--include": "include", "-i": "include", "--silent": "silent" },
	);
	let endpoint = flags.positional[0];
	if (!endpoint) throw new GhError("usage: gh api ENDPOINT [-X METHOD] [-f key=value] [-F key=value] [--jq EXPR] [--paginate]");
	if (endpoint.includes("{owner}") || endpoint.includes("{repo}")) {
		const repo = await currentRepo(ctx, flags);
		endpoint = endpoint.replaceAll("{owner}", repo.owner).replaceAll("{repo}", repo.name);
	}
	const fields: Record<string, unknown> = {};
	for (const pair of flags.values.get("raw") ?? []) fields[pair.slice(0, pair.indexOf("="))] = pair.slice(pair.indexOf("=") + 1);
	for (const pair of flags.values.get("field") ?? []) {
		const key = pair.slice(0, pair.indexOf("="));
		const raw = pair.slice(pair.indexOf("=") + 1);
		fields[key] = raw.startsWith("@") ? await ctx.fs.readFile(raw.slice(1).startsWith("/") ? raw.slice(1) : `${ctx.cwd}/${raw.slice(1)}`) : typedField(raw);
	}
	const graphql = endpoint === "graphql";
	const input = one(flags, "input");
	const hasFields = Object.keys(fields).length > 0;
	const method = (one(flags, "method") ?? (hasFields || graphql || input ? "POST" : "GET")).toUpperCase();
	let path = graphql ? "/graphql" : endpoint;
	let body: unknown;
	if (input !== undefined) body = jsonOrText(input === "-" ? ctx.stdin.toString() : await ctx.fs.readFile(input.startsWith("/") ? input : `${ctx.cwd}/${input}`));
	else if (graphql) body = { query: fields.query, variables: Object.fromEntries(Object.entries(fields).filter(([key]) => key !== "query")) };
	else if (hasFields && method === "GET") path += `${path.includes("?") ? "&" : "?"}${new URLSearchParams(Object.entries(fields).map(([key, value]) => [key, text(value)]))}`;
	else if (hasFields) body = fields;
	const headers = Object.fromEntries((flags.values.get("header") ?? []).map((header) => [header.slice(0, header.indexOf(":")).trim(), header.slice(header.indexOf(":") + 1).trim()]));
	const accept = headers.Accept ?? headers.accept ?? "application/vnd.github+json";
	const pages: string[] = [];
	let next: string | undefined = path;
	let status = 0;
	while (next) {
		const response = await client.raw(method, next, body, accept, headers);
		status = response.status;
		if (!response.ok) return { stdout: response.text ? `${response.text}\n` : "", stderr: `gh: ${apiMessage(response.text) || "request failed"} (HTTP ${response.status})\n`, exitCode: 1 };
		pages.push(response.text);
		next = flags.set.has("paginate") && method === "GET" ? nextPage(response.link) : undefined;
	}
	if (flags.set.has("silent")) return ok("");
	const parsed = pages.length > 1 ? pages.map(jsonOrText) : [];
	const merged = parsed.length > 1 && parsed.every(Array.isArray) ? JSON.stringify(parsed.flat()) : pages.join("\n");
	const result = await filter(ctx, flags, merged);
	return flags.set.has("include") ? { ...result, stdout: `HTTP ${status}\n\n${result.stdout}` } : result;
}

async function repoCommand(args: string[], ctx: Ctx, client: Api): Promise<ExecResult> {
	const [action = "", ...rest] = args;
	if (action === "clone") {
		const flags = parseFlags(rest, {}, {});
		const [spec, directory, ...gitFlags] = flags.positional;
		const repo = spec ? parseRepo(spec) : undefined;
		if (!repo) throw new GhError("usage: gh repo clone OWNER/REPO [DIRECTORY] [-- git flags]");
		const words = ["git", "clone", ...gitFlags, `https://github.com/${repo.owner}/${repo.name}.git`, ...(directory ? [directory] : [])];
		const result = await ctx.exec?.(words.map(shellQuote).join(" "), { cwd: ctx.cwd });
		return result ?? failed("git is not available");
	}
	if (action === "view") {
		const flags = parseFlags(rest, VIEW_FLAGS, {});
		const given = flags.positional[0];
		const repo = given ? parseRepo(given) : await currentRepo(ctx, flags);
		if (!repo) throw new GhError(`expected OWNER/REPO, got ${given}`);
		const json = one(flags, "json");
		const [info, readme] = await Promise.all([
			client.json("GET", `/repos/${repo.owner}/${repo.name}`),
			json === undefined ? client.raw("GET", `/repos/${repo.owner}/${repo.name}/readme`, undefined, "application/vnd.github.raw") : undefined,
		]);
		const fields = ["name", "nameWithOwner", "description", "url", "defaultBranchRef", "isPrivate", "stargazerCount", "updatedAt"];
		if (json !== undefined) {
			const values: Record<string, unknown> = {
				name: at(info, "name"),
				nameWithOwner: at(info, "full_name"),
				description: at(info, "description"),
				url: at(info, "html_url"),
				defaultBranchRef: { name: at(info, "default_branch") },
				isPrivate: at(info, "private"),
				stargazerCount: at(info, "stargazers_count"),
				updatedAt: at(info, "updated_at"),
			};
			const wanted = json.split(",").map((field) => field.trim()).filter(Boolean);
			const unknown = wanted.filter((field) => !fields.includes(field));
			if (wanted.length === 0 || unknown.length > 0) throw new GhError(`Available fields:\n  ${fields.join("\n  ")}`);
			return filter(ctx, flags, JSON.stringify(Object.fromEntries(wanted.map((field) => [field, values[field]])), null, 2));
		}
		return ok(`name:\t${text(at(info, "full_name"))}\ndescription:\t${text(at(info, "description"))}\n--\n${readme?.ok ? readme.text : ""}\n`);
	}
	throw new GhError(`unknown command "repo ${action}"; supported: clone, view. Use \`gh api\` for anything else.`);
}

const SEARCH_KINDS: Record<string, string> = { issues: "is:issue", prs: "is:pr" };

async function searchCommand(args: string[], ctx: Ctx, client: Api): Promise<ExecResult> {
	const [kind = "", ...rest] = args;
	const qualifier = SEARCH_KINDS[kind];
	if (!qualifier) throw new GhError(`unknown command "search ${kind}"; supported: issues, prs. Use \`gh api search/...\` for anything else.`);
	const flags = parseFlags(rest, { "--repo": "repo", "-R": "repo", "--owner": "owner", "--state": "state", "--author": "author", "--label": "label", "--limit": "limit", "-L": "limit", "--json": "json", "--jq": "jq", "-q": "jq" }, {});
	const state = one(flags, "state");
	const terms = [
		...flags.positional,
		qualifier,
		...(flags.values.get("repo") ?? []).map((repo) => `repo:${repo}`),
		...(flags.values.get("owner") ?? []).map((owner) => `user:${owner}`),
		...(flags.values.get("label") ?? []).map((label) => `label:"${label}"`),
		state ? `state:${state}` : "",
		one(flags, "author") ? `author:${one(flags, "author")}` : "",
	].filter(Boolean);
	if (flags.positional.length === 0 && terms.length === 1) throw new GhError(`usage: gh search ${kind} QUERY [--repo OWNER/REPO] [--state open|closed] [--limit N]`);
	const limit = Math.min(100, Number(one(flags, "limit") ?? DEFAULT_LIMIT));
	const result = await client.json("GET", `/search/issues?per_page=${limit}&q=${encodeURIComponent(terms.join(" "))}`);
	const matches = at(result, "items");
	const found = (Array.isArray(matches) ? matches : []).slice(0, limit);
	const repoOf = (item: unknown) => text(at(item, "repository_url")).replace(`${API}/repos/`, "");
	return present(ctx, flags, found, [...ITEM_FIELDS, "repository"], () =>
		found.map((item) => `${[repoOf(item), text(at(item, "number")), text(itemField(item, "state")), text(at(item, "title")), text(at(item, "updated_at"))].join("\t")}\n`).join(""),
	);
}

async function auth(args: string[], client: Api): Promise<ExecResult> {
	if (args[0] !== "status") throw new GhError("only `gh auth status` is available: the token comes from pi mobile's settings");
	const response = await client.raw("GET", "/user");
	if (!response.ok) return failed("github.com\n  X Not logged in: add a GitHub token in pi mobile's settings");
	return ok(`github.com\n  ✓ Logged in to github.com account ${text(at(jsonOrText(response.text), "login"))} (token from pi mobile's settings)\n`);
}

export function ghCommand(fetch: FolderFetch): Command {
	const client = new Api(fetch);
	return defineCommand("gh", async (args, ctx) => {
		const [group = "", ...rest] = args;
		try {
			switch (group) {
				case "api":
					return await api(rest, ctx, client);
				case "pr":
				case "issue":
					return await items(group, rest, ctx, client);
				case "repo":
					return await repoCommand(rest, ctx, client);
				case "search":
					return await searchCommand(rest, ctx, client);
				case "auth":
					return await auth(rest, client);
			}
			return failed(`gh: unknown command "${group}"; this gh has api, pr, issue, repo, search, auth status`);
		} catch (error) {
			if (error instanceof GhError) return failed(`gh: ${error.message}`);
			throw error;
		}
	});
}
