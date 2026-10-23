import { Capacitor, CapacitorHttp, registerPlugin } from "@capacitor/core";
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { prepareAttachment } from "../attachments.ts";
import { fromBase64, PhoneEnv } from "../files/phone-env.ts";
import { defineExtension } from "@earendil-works/pi-durable";
import { defineAppTool } from "./common.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { parse } from "../parse.ts";
import { messageOf } from "../../promise.ts";

const ResponsesAnswer = Type.Object({
	output: Type.Optional(
		Type.Array(
			Type.Object({
				type: Type.String(),
				content: Type.Optional(
					Type.Array(
						Type.Object({
							text: Type.Optional(Type.String()),
							annotations: Type.Optional(Type.Array(Type.Object({ url: Type.Optional(Type.String()), title: Type.Optional(Type.String()) }))),
						}),
					),
				),
			}),
		),
	),
});

const MessagesAnswer = Type.Object({
	content: Type.Optional(
		Type.Array(
			Type.Object({
				type: Type.String(),
				text: Type.Optional(Type.String()),
				content: Type.Optional(Type.Unknown()),
			}),
		),
	),
});
const SearchResults = Type.Array(Type.Object({ url: Type.Optional(Type.String()), title: Type.Optional(Type.String()) }));

const MAX_FETCH_CHARS = 40_000;
const RENDER_BELOW_CHARS = 300;

const Page = registerPlugin<{ render(options: { url: string }): Promise<{ html: string; title: string; url: string; ms: number; settled: boolean }> }>("Page");

const visibleLength = (text: string) => text.replace(/^# .*\n/, "").replace(/\s+/g, "").length;

const formatSize = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

async function readPdf(url: string, conversationId: string): Promise<(TextContent | ImageContent)[]> {
	const response = await CapacitorHttp.get({ url, responseType: "arraybuffer", headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 16) pi-mobile" }, connectTimeout: 15_000, readTimeout: 60_000 });
	if (response.status >= 400 || typeof response.data !== "string") throw new Error(`HTTP ${response.status} ${response.url}`);
	const name = decodeURIComponent(new URL(response.url || url).pathname.split("/").pop() || "page").replace(/\.pdf$/i, "") + ".pdf";
	const bytes = fromBase64(response.data);
	const prepared = await prepareAttachment(new File([bytes as Uint8Array<ArrayBuffer>], name, { type: "application/pdf" }), conversationId);
	return [{ type: "text", text: `PDF ${response.url || url}` }, ...prepared.content];
}

async function download(env: ExecutionEnv, url: string, path: string, context: Context): Promise<{ path: string; size: number; contentType: string; url: string }> {
	if (env instanceof PhoneEnv) {
		const saved = await env.download(url, path, context);
		if (!saved.ok) throw saved.error;
		return saved.value;
	}
	const absolute = await env.absolutePath(path, context);
	if (!absolute.ok) throw absolute.error;
	const response = await CapacitorHttp.get({ url, responseType: "arraybuffer", headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 16) pi-mobile" }, connectTimeout: 15_000, readTimeout: 60_000 });
	if (response.status >= 400) throw new Error(`HTTP ${response.status} ${response.url}`);
	const bytes = typeof response.data === "string" ? fromBase64(response.data) : new Uint8Array(0);
	const written = await env.writeFile(absolute.value, bytes, context);
	if (!written.ok) throw written.error;
	const contentType = String(Object.entries(response.headers).find(([key]) => key.toLowerCase() === "content-type")?.[1] ?? "");
	return { path: absolute.value, size: bytes.length, contentType, url: response.url || url };
}

export interface WebConfig {
	baseUrl: string;
	apiKey: string;
	modelIds: readonly string[];
}

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
		.flatMap((block) => (Value.Check(SearchResults, block.content) ? block.content : []))
		.filter((result) => result.url)
		.map((result) => `- ${result.title ?? result.url}: ${result.url}`);
	return [text, sources.length ? `\nSources:\n${[...new Set(sources)].join("\n")}` : ""].join("\n");
}

function htmlToText(html: string): string {
	const doc = new DOMParser().parseFromString(html, "text/html");
	for (const element of doc.querySelectorAll("script, style, noscript, svg, nav, footer, header, aside, form, iframe")) element.remove();
	const main = doc.querySelector("main, article");
	const root = main && (main.textContent?.length ?? 0) * 2 >= (doc.body?.textContent?.length ?? 0) ? main : doc.body;
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

	const search = defineAppTool({
		name: "web_search",
		description:
			"Search the web for current information (news, docs, releases, prices, facts after your training data). Returns a short answer with source URLs; follow up with web_fetch to read a page. A search takes 20-60 s: one search per bank, product, or source, asked for together.",
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

	const fetchPage = defineAppTool({
		name: "web_fetch",
		description:
			"Fetch a web page (http or https) and return its readable text with links, the raw body for JSON and plain text, or a PDF's text by page (read more with read_attachment). With save_to, download the file (PDF, image, spreadsheet…) into your folder instead.",
		parameters: Type.Object({
			url: Type.String({ description: "http:// or https:// URL of the page or file" }),
			render: Type.Optional(
				Type.Boolean({
					description: "Rarely needed: a page with almost no text is rendered anyway. Only after a fetch whose text lacked what the page should show (numbers, a table, a list): load it in a browser and run its scripts, which takes seconds.",
				}),
			),
			save_to: Type.Optional(Type.String({ description: "Path in your folder to download the file to, e.g. rates.pdf; then read or share it" })),
		}),
		execute: async (args, api, context) => {
			if (!/^https?:\/\//.test(args.url)) throw new Error("url must start with http:// or https://");
			if (args.save_to) {
				if (!api.env) throw new Error("this bot has no folder to save to");
				const saved = await download(api.env, args.url, args.save_to, context);
				return { output: [{ type: "text", text: `Saved ${formatSize(saved.size)}${saved.contentType ? ` (${saved.contentType})` : ""} from ${saved.url} to ${saved.path}.` }] };
			}
			const response = await CapacitorHttp.get({
				url: args.url,
				headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 16) pi-mobile", Accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.5" },
				responseType: "text",
				connectTimeout: 15_000,
				readTimeout: 30_000,
			});
			const type = String(Object.entries(response.headers).find(([key]) => key.toLowerCase() === "content-type")?.[1] ?? "");
			if (response.status < 400 && type.includes("pdf")) return { output: await readPdf(response.url || args.url, String(api.conversationId)) };
			const body = typeof response.data === "string" ? response.data : JSON.stringify(response.data, null, 2);
			const html = type.includes("html");
			let text = html ? htmlToText(body) : body;
			let header = `HTTP ${response.status} ${response.url}`;
			if (html && response.status < 400 && Capacitor.isNativePlatform() && (args.render || visibleLength(text) < RENDER_BELOW_CHARS)) {
				const page = await Page.render({ url: response.url || args.url }).then(
					(value) => ({ ok: true as const, value }),
					(error: unknown) => ({ ok: false as const, message: messageOf(error) }),
				);
				if (!page.ok) {
					header += `\n[rendering failed: ${page.message}; this is the page without its scripts]`;
				} else {
					text = htmlToText(page.value.html);
					header = `Rendered ${page.value.url} (${(page.value.ms / 1000).toFixed(1)} s${page.value.settled ? "" : ", still changing at the deadline"})`;
				}
			}
			const cut = text.length > MAX_FETCH_CHARS ? `${text.slice(0, MAX_FETCH_CHARS)}\n\n[truncated: ${text.length - MAX_FETCH_CHARS} more characters]` : text;
			if (response.status >= 400) throw new Error(`${header}\n${cut.slice(0, 2000)}`);
			return { output: [{ type: "text", text: `${header}\n\n${cut}` }] };
		},
	});

	return defineExtension({ name: "web", tools: [search, fetchPage] });
}
