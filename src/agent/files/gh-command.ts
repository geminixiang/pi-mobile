import { type Command, defineCommand, type ExecResult, type ResolvedCommandContext } from "just-bash/browser";
import type { FolderFetch } from "./folder-fetch.ts";
import { jsonOrText } from "../../parse.ts";
import { shellQuote } from "../shell.ts";

const API = "https://api.github.com";
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
}

function nextPage(link: string): string | undefined {
	return /<([^>]+)>;\s*rel="next"/.exec(link)?.[1];
}

async function filter(ctx: Ctx, flags: Flags, json: string): Promise<ExecResult> {
	const expression = one(flags, "jq");
	if (expression === undefined) return ok(`${json}\n`);
	const result = await ctx.exec?.(`jq -r ${shellQuote(expression)}`, { cwd: ctx.cwd, stdin: json });
	return result ?? failed("jq is not available");
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
		fields[key] = raw.startsWith("@") ? await ctx.fs.readFile(ctx.fs.resolvePath(ctx.cwd, raw.slice(1))) : typedField(raw);
	}
	const graphql = endpoint === "graphql";
	const input = one(flags, "input");
	const hasFields = Object.keys(fields).length > 0;
	const method = (one(flags, "method") ?? (hasFields || graphql || input ? "POST" : "GET")).toUpperCase();
	let path = graphql ? "/graphql" : endpoint;
	let body: unknown;
	if (input !== undefined) body = jsonOrText(input === "-" ? ctx.stdin.toString() : await ctx.fs.readFile(ctx.fs.resolvePath(ctx.cwd, input)));
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
	const merged = parsed.every(Array.isArray) && parsed.length > 0 ? JSON.stringify(parsed.flat()) : pages.join("\n");
	const result = await filter(ctx, flags, merged);
	return flags.set.has("include") ? { ...result, stdout: `HTTP ${status}\n\n${result.stdout}` } : result;
}

async function auth(args: string[], client: Api): Promise<ExecResult> {
	if (args[0] !== "status") throw new GhError("only `gh auth status` is available: the token comes from pi mobile's settings");
	const response = await client.raw("GET", "/user");
	if (!response.ok) return failed("github.com\n  X Not logged in: add a GitHub token in pi mobile's settings");
	return ok(`github.com\n  ✓ Logged in to github.com account ${text(at(jsonOrText(response.text), "login"))} (token from pi mobile's settings)\n`);
}

const GH_COMMANDS: Record<string, { usage: string; run: (args: string[], ctx: Ctx, client: Api) => Promise<ExecResult> }> = {
	api: { usage: "api", run: api },
	auth: { usage: "auth status", run: (args, _ctx, client) => auth(args, client) },
};

export const GH_USAGE = Object.values(GH_COMMANDS)
	.map((command) => command.usage)
	.join(", ");

export function ghCommand(fetch: FolderFetch): Command {
	const client = new Api(fetch);
	return defineCommand("gh", async (args, ctx) => {
		const [group = "", ...rest] = args;
		const command = GH_COMMANDS[group];
		if (!command) return failed(`gh: unknown command "${group}"; this gh has ${GH_USAGE}`);
		try {
			return await command.run(rest, ctx, client);
		} catch (error) {
			if (error instanceof GhError) return failed(`gh: ${error.message}`);
			throw error;
		}
	});
}
