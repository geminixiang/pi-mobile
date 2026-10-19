// Web tools, run from the phone. Search uses the model service's own hosted search (OpenAI Responses `web_search`, or
// Anthropic Messages `web_search_20250305`), so it works with any endpoint that passes those through, with no search
// API key. Fetch uses Capacitor's native HTTP, which is not subject to the WebView's CORS rules.
import { CapacitorHttp } from "@capacitor/core";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type as T } from "typebox";
import { Value } from "typebox/value";
import { parse } from "../parse.ts";

/** The parts of a Responses API answer read here: message text and its URL citations. */
const ResponsesAnswer = T.Object({
	output: T.Optional(
		T.Array(
			T.Object({
				type: T.String(),
				content: T.Optional(
					T.Array(
						T.Object({
							text: T.Optional(T.String()),
							annotations: T.Optional(T.Array(T.Object({ url: T.Optional(T.String()), title: T.Optional(T.String()) }))),
						}),
					),
				),
			}),
		),
	),
});

/** The parts of a Messages API answer read here: text blocks and web search results. */
const MessagesAnswer = T.Object({
	content: T.Optional(
		T.Array(
			T.Object({
				type: T.String(),
				text: T.Optional(T.String()),
				content: T.Optional(T.Unknown()),
			}),
		),
	),
});
const SearchResults = T.Array(T.Object({ url: T.Optional(T.String()), title: T.Optional(T.String()) }));

const MAX_FETCH_CHARS = 40_000;

export interface WebConfig {
	baseUrl: string;
	apiKey: string;
	/** Model IDs the endpoint offers; the search backend is picked from these. */
	modelIds: readonly string[];
}

/** First available model per backend, best first. */
const RESPONSES_SEARCH_MODELS = [/^gpt-6\.1/, /^gpt-6/, /^gpt-5\.6/, /^gpt-5/];
const ANTHROPIC_SEARCH_MODELS = [/^claude-sonnet/, /^claude-opus/, /^claude/];

function pick(ids: readonly string[], patterns: RegExp[]): string | undefined {
	for (const pattern of patterns) {
		const found = ids.find((id) => pattern.test(id));
		if (found) return found;
	}
	return undefined;
}

function root(baseUrl: string): string {
	return baseUrl.replace(/\/+$/u, "").replace(/\/v1$/u, "");
}

const INSTRUCTIONS =
	"Search the web for the query and answer it concisely with the facts found, in the query's language. List the source URLs you relied on.";

async function searchResponses(config: WebConfig, model: string, query: string, signal: AbortSignal): Promise<string> {
	const response = await fetch(`${root(config.baseUrl)}/v1/responses`, {
		method: "POST",
		headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({ model, instructions: INSTRUCTIONS, input: query, tools: [{ type: "web_search" }] }),
		signal,
	});
	if (!response.ok) throw new Error(`web search (${model}): HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
	const body = parse(ResponsesAnswer, await response.json(), "web search 回應");
	const parts = (body.output ?? []).filter((item) => item.type === "message").flatMap((item) => item.content ?? []);
	const text = parts.map((part) => part.text ?? "").join("\n").trim();
	const sources = new Map<string, string>();
	for (const part of parts) for (const note of part.annotations ?? []) if (note.url) sources.set(note.url, note.title ?? note.url);
	return [text, sources.size ? `\nSources:\n${[...sources].map(([url, title]) => `- ${title}: ${url}`).join("\n")}` : ""].join("\n");
}

async function searchAnthropic(config: WebConfig, model: string, query: string, signal: AbortSignal): Promise<string> {
	const response = await fetch(`${root(config.baseUrl)}/v1/messages`, {
		method: "POST",
		headers: {
			"x-api-key": config.apiKey,
			"anthropic-version": "2023-06-01",
			"anthropic-dangerous-direct-browser-access": "true",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model,
			max_tokens: 2000,
			system: INSTRUCTIONS,
			tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
			messages: [{ role: "user", content: query }],
		}),
		signal,
	});
	if (!response.ok) throw new Error(`web search (${model}): HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
	const body = parse(MessagesAnswer, await response.json(), "web search 回應");
	const text = (body.content ?? []).flatMap((block) => (block.type === "text" ? [block.text ?? ""] : [])).join("").trim();
	const sources = (body.content ?? [])
		.filter((block) => block.type === "web_search_tool_result")
		// A result block holds an array of results, or an error object that has no sources.
		.flatMap((block) => (Value.Check(SearchResults, block.content) ? block.content : []))
		.filter((result) => result.url)
		.map((result) => `- ${result.title ?? result.url}: ${result.url}`);
	return [text, sources.length ? `\nSources:\n${[...new Set(sources)].join("\n")}` : ""].join("\n");
}

/** Visible text of an HTML page: title, then the body without scripts, styles, and navigation chrome. */
function htmlToText(html: string): string {
	const doc = new DOMParser().parseFromString(html, "text/html");
	for (const element of doc.querySelectorAll("script, style, noscript, svg, nav, footer, header, aside, form, iframe")) element.remove();
	const root = doc.querySelector("main, article") ?? doc.body;
	for (const element of root?.querySelectorAll("p, div, li, h1, h2, h3, h4, h5, h6, tr, br, pre, blockquote") ?? []) element.append("\n");
	for (const link of root?.querySelectorAll("a[href]") ?? []) {
		const href = link.getAttribute("href") ?? "";
		if (/^https?:/.test(href) && link.textContent?.trim()) link.append(` (${href})`);
	}
	const text = (root?.textContent ?? "").replace(/[ \t\u00a0]+/g, " ").replace(/\n\s*\n\s*/g, "\n\n").trim();
	return `${doc.title ? `# ${doc.title.trim()}\n\n` : ""}${text}`;
}

export function createWebExtension(config: WebConfig) {
	const responsesModel = pick(config.modelIds, RESPONSES_SEARCH_MODELS);
	const anthropicModel = pick(config.modelIds, ANTHROPIC_SEARCH_MODELS);

	const search = defineTool({
		name: "web_search",
		description:
			"Search the web for current information (news, docs, releases, prices, facts after your training data). Returns a short answer with source URLs; follow up with web_fetch to read a page.",
		parameters: Type.Object({ query: Type.String({ description: "What to find, as a question or keywords" }) }),
		execute: async (args, _api, context) => {
			const timeout = AbortSignal.timeout(120_000);
			const signal = context.abortSignal ? AbortSignal.any([context.abortSignal, timeout]) : timeout;
			let text: string;
			if (responsesModel) text = await searchResponses(config, responsesModel, args.query, signal);
			else if (anthropicModel) text = await searchAnthropic(config, anthropicModel, args.query, signal);
			else throw new Error("The model service offers no model with hosted web search (GPT or Claude).");
			return { output: [{ type: "text", text: text || "No results." }] };
		},
	});

	const fetchPage = defineTool({
		name: "web_fetch",
		description: "Fetch a web page (http or https) and return its readable text with links, or the raw body for JSON and plain text.",
		parameters: Type.Object({ url: Type.String() }),
		execute: async (args) => {
			if (!/^https?:\/\//.test(args.url)) throw new Error("url must start with http:// or https://");
			const response = await CapacitorHttp.get({
				url: args.url,
				headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 16) pi-mobile", Accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.5" },
				responseType: "text",
				connectTimeout: 15_000,
				readTimeout: 30_000,
			});
			const type = String(Object.entries(response.headers).find(([key]) => key.toLowerCase() === "content-type")?.[1] ?? "");
			const body = typeof response.data === "string" ? response.data : JSON.stringify(response.data, null, 2);
			const text = type.includes("html") ? htmlToText(body) : body;
			const cut = text.length > MAX_FETCH_CHARS ? `${text.slice(0, MAX_FETCH_CHARS)}\n\n[truncated: ${text.length - MAX_FETCH_CHARS} more characters]` : text;
			const header = `HTTP ${response.status} ${response.url}`;
			if (response.status >= 400) throw new Error(`${header}\n${cut.slice(0, 2000)}`);
			return { output: [{ type: "text", text: `${header}\n\n${cut}` }] };
		},
	});

	return defineExtension({ name: "web", tools: [search, fetchPage] });
}
