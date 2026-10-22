// GitHub connector: the REST API called straight from the phone with the user's token.
// Reads run directly; every write asks the user first.
import { isJsonValue, type JsonValue } from "@earendil-works/chord";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { parse } from "../parse.ts";
import { approve, defineAppTool } from "./common.ts";

/** GET /repos/{owner}/{repo}/contents/{path}: a directory listing, or one file. */
const DirectoryListing = Type.Array(Type.Object({ type: Type.String(), path: Type.String(), size: Type.Number() }));
const FileContents = Type.Object({
	encoding: Type.Optional(Type.String()),
	content: Type.Optional(Type.String()),
	size: Type.Optional(Type.Number()),
	download_url: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const API = "https://api.github.com";
const MAX_OUTPUT_CHARS = 40_000;

/** A parsed response body as a JSON value: JSON.parse only produces those; anything else becomes null. */
function toJson(value: unknown): JsonValue {
	return isJsonValue(value) ? value : null;
}

export type TokenSource = () => Promise<string | undefined>;

function text(value: string) {
	const truncated =
		value.length > MAX_OUTPUT_CHARS
			? `${value.slice(0, MAX_OUTPUT_CHARS)}\n\n[truncated: ${value.length - MAX_OUTPUT_CHARS} more characters; narrow the request with per_page, a path, or a search query]`
			: value;
	return { output: [{ type: "text" as const, text: truncated }] };
}

async function github(token: string, method: string, path: string, body?: unknown, signal?: AbortSignal) {
	const response = await fetch(`${API}${path}`, {
		method,
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${token}`,
			"X-GitHub-Api-Version": "2022-11-28",
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		signal,
	});
	const raw = await response.text();
	let parsed: unknown = raw;
	try {
		parsed = raw ? JSON.parse(raw) : null;
	} catch {
		// Non-JSON bodies (diffs, raw media types) are returned as text.
	}
	return { status: response.status, ok: response.ok, link: response.headers.get("link") ?? undefined, body: parsed };
}

export function createGitHubExtension(getToken: TokenSource) {
	async function requireToken(): Promise<string> {
		const token = await getToken();
		if (!token) throw new Error("GitHub is not connected. Ask the user to add a GitHub token in Settings.");
		return token;
	}

	const api = defineAppTool({
		name: "github_api",
		description: [
			"Call the GitHub REST API as the user. `path` starts with /, e.g. /user, /repos/{owner}/{repo}/issues?state=open&per_page=20,",
			"/search/issues?q=..., /repos/{owner}/{repo}/pulls/{n}/files. GET runs immediately; POST, PATCH, PUT, and DELETE",
			"show the user a confirmation dialog first and fail if they decline. Prefer small per_page values.",
		].join(" "),
		// Scripts get the parsed response, so `(await tools.github_api(...)).body.login` works without parsing text.
		structuredOutputSchema: Type.Object({ status: Type.Integer(), link: Type.Optional(Type.String()), body: Type.Unknown() }),
		parameters: Type.Object({
			method: Type.Union([
				Type.Literal("GET"),
				Type.Literal("POST"),
				Type.Literal("PATCH"),
				Type.Literal("PUT"),
				Type.Literal("DELETE"),
			]),
			path: Type.String({ description: "API path with query string, starting with /" }),
			body: Type.Optional(Type.Unknown({ description: "JSON request body for POST, PATCH, and PUT" })),
			reason: Type.Optional(Type.String({ description: "For writes: one sentence shown to the user in the confirmation dialog" })),
		}),
		execute: async (args, _api, context) => {
			if (!args.path.startsWith("/")) throw new Error("path must start with /");
			const token = await requireToken();
			// Models sometimes pass the body as a JSON string; send it as the object it encodes.
			if (typeof args.body === "string") {
				try {
					args.body = JSON.parse(args.body);
				} catch {
					// Not JSON: send the string as is.
				}
			}
			if (args.method !== "GET") {
				const declined = await approve(
					{
						title: `GitHub ${args.method} ${args.path}`,
						detail: [args.reason, args.body === undefined ? undefined : JSON.stringify(args.body, null, 2)].filter(Boolean).join("\n\n"),
					},
					"好，不做。",
				);
				if (declined) return declined;
			}
			const result = await github(token, args.method, args.path, args.body, context.abortSignal);
			const header = `HTTP ${result.status}${result.link ? `\nLink: ${result.link}` : ""}`;
			const body = typeof result.body === "string" ? result.body : JSON.stringify(result.body);
			if (!result.ok) throw new Error(`${header}\n${body}`);
			return {
				...text(`${header}\n${body}`),
				structuredOutput: { status: result.status, ...(result.link ? { link: result.link } : {}), body: toJson(result.body) },
			};
		},
	});

	const readFile = defineAppTool({
		name: "github_read_file",
		description: "Read a file from a GitHub repository as text, or list a directory.",
		parameters: Type.Object({
			owner: Type.String({ description: "The repository's owner, a user or organization" }),
			repo: Type.String({ description: "The repository's name" }),
			path: Type.String({ description: "Path inside the repository; empty for the root" }),
			ref: Type.Optional(Type.String({ description: "Branch, tag, or commit; default branch if omitted" })),
		}),
		execute: async (args, _api, context) => {
			const token = await requireToken();
			const path = args.path.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
			const query = args.ref ? `?ref=${encodeURIComponent(args.ref)}` : "";
			const result = await github(token, "GET", `/repos/${args.owner}/${args.repo}/contents/${path}${query}`, undefined, context.abortSignal);
			if (!result.ok) throw new Error(`HTTP ${result.status}\n${JSON.stringify(result.body)}`);
			if (Value.Check(DirectoryListing, result.body)) {
				return text(result.body.map((entry) => `${entry.type === "dir" ? "dir " : "file"} ${entry.path}${entry.type === "file" ? ` (${entry.size} B)` : ""}`).join("\n"));
			}
			const file = parse(FileContents, result.body, "GitHub 檔案內容");
			if (file.encoding !== "base64" || file.content === undefined) {
				return text(`File too large for the contents API (${file.size} bytes). Download URL: ${file.download_url}`);
			}
			const bytes = Uint8Array.from(atob(file.content.replace(/\n/g, "")), (char) => char.charCodeAt(0));
			return text(new TextDecoder().decode(bytes));
		},
	});

	return defineExtension({
		name: "github",
		sections: [
			section(
				"github",
				() =>
					"GitHub: github_api and github_read_file; GET /user tells who the user is. Writes need the user's approval; say what you will change first.",
			),
		],
		tools: [api, readFile],
	});
}
