import { defineExtension } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { parse, jsonOrText } from "../parse.ts";
import { defineAppTool, jsonOrNull, oneOf, text as textResult, truncated } from "./common.ts";
import { fromBase64 } from "../../encoding.ts";

const DirectoryListing = Type.Array(Type.Object({ type: Type.String(), path: Type.String(), size: Type.Number() }));
const FileContents = Type.Object({
	encoding: Type.Optional(Type.String()),
	content: Type.Optional(Type.String()),
	size: Type.Optional(Type.Number()),
	download_url: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const API = "https://api.github.com";

const text = (value: string) => textResult(truncated(value, "; narrow the request with per_page, a path, or a search query"));

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
	const parsed = raw ? jsonOrText(raw) : null;
	return { status: response.status, ok: response.ok, link: response.headers.get("link") ?? undefined, body: parsed };
}

export function createGitHubExtension(token: string) {
	const api = defineAppTool({
		name: "github_api",
		effect: "direct",
		description: [
			"Call the GitHub REST API as the user. `path` starts with /, e.g. /user, /repos/{owner}/{repo}/issues?state=open&per_page=20,",
			"/search/issues?q=..., /repos/{owner}/{repo}/pulls/{n}/files. POST, PATCH, PUT, and DELETE change things as the user.",
			"Prefer small per_page values.",
		].join(" "),
		structuredOutputSchema: Type.Object({ status: Type.Integer(), link: Type.Optional(Type.String()), body: Type.Unknown() }),
		parameters: Type.Object({
			method: oneOf(["GET", "POST", "PATCH", "PUT", "DELETE"]),
			path: Type.String({ description: "API path with query string, starting with /" }),
			body: Type.Optional(Type.Unknown({ description: "JSON request body for POST, PATCH, and PUT" })),
		}),
		execute: async (args, _api, context) => {
			if (!args.path.startsWith("/")) throw new Error("path must start with /");
			const requestBody: unknown = typeof args.body === "string" ? jsonOrText(args.body) : args.body;
			const result = await github(token, args.method, args.path, requestBody, context.abortSignal);
			const header = `HTTP ${result.status}${result.link ? `\nLink: ${result.link}` : ""}`;
			const body = typeof result.body === "string" ? result.body : JSON.stringify(result.body);
			if (!result.ok) throw new Error(`${header}\n${body}`);
			return {
				...text(`${header}\n${body}`),
				structuredOutput: { status: result.status, ...(result.link ? { link: result.link } : {}), body: jsonOrNull(result.body) },
			};
		},
	});

	const readFile = defineAppTool({
		name: "github_read_file",
		effect: "read",
		description: "Read a file from a GitHub repository as text, or list a directory.",
		parameters: Type.Object({
			owner: Type.String({ description: "The repository's owner, a user or organization" }),
			repo: Type.String({ description: "The repository's name" }),
			path: Type.String({ description: "Path inside the repository; empty for the root" }),
			ref: Type.Optional(Type.String({ description: "Branch, tag, or commit; default branch if omitted" })),
		}),
		execute: async (args, _api, context) => {
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
			const bytes = fromBase64(file.content.replace(/\n/g, ""));
			return text(new TextDecoder().decode(bytes));
		},
	});

	return defineExtension({
		name: "github",
		tools: [api, readFile],
	});
}
