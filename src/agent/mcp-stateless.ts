import { type AuthProvider, type CallToolResult, type ContentBlock, type McpFetch, McpError, isJsonRpcResponse, parseJsonRpcMessage } from "@earendil-works/pi-mcp";
import { type Static, Type } from "typebox";
import { check, jsonOrText } from "../parse.ts";
import { orLogged } from "../promise.ts";

const STATELESS_VERSION = "2026-07-28";
const MAX_ROUNDS = 4;

export type Endpoint = { url: string; fetch: McpFetch; auth: AuthProvider };

const FormSchema = Type.Object({
	type: Type.Literal("object"),
	properties: Type.Record(Type.String(), Type.Object({ type: Type.Optional(Type.String()), title: Type.Optional(Type.String()), description: Type.Optional(Type.String()) })),
	required: Type.Optional(Type.Array(Type.String())),
});
export type FormSchema = Static<typeof FormSchema>;

export type FormRequest = { message: string; schema: FormSchema };
export type FormAnswer = { action: "accept"; content: Record<string, boolean | string | number> } | { action: "decline" } | { action: "cancel" };

const FormElicitation = Type.Object({
	method: Type.Literal("elicitation/create"),
	params: Type.Object({ mode: Type.Optional(Type.Literal("form")), message: Type.String(), requestedSchema: FormSchema }),
});

const InputRequired = Type.Object({
	resultType: Type.Literal("input_required"),
	inputRequests: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	requestState: Type.Optional(Type.String()),
});

const ToolResult = Type.Object({
	content: Type.Array(Type.Unsafe<ContentBlock>(Type.Object({ type: Type.String() }))),
	structuredContent: Type.Optional(Type.Unknown()),
	isError: Type.Optional(Type.Boolean()),
});

const Discovered = Type.Object({ supportedVersions: Type.Array(Type.String()) });

const meta = {
	"io.modelcontextprotocol/protocolVersion": STATELESS_VERSION,
	"io.modelcontextprotocol/clientInfo": { name: "pi-mobile", version: "1.0.0" },
	"io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
};

const ASCII_HEADER = /^[\x20-\x7e]*$/;
const headerValue = (value: string) => (ASCII_HEADER.test(value) ? value : `=?base64?${btoa(String.fromCodePoint(...new TextEncoder().encode(value)))}?=`);

const PASSING_STATUSES = new Set([401, 403, 408, 429]);

class HttpRefusal extends Error {
	readonly final: boolean;

	constructor(method: string, status: number) {
		super(`MCP ${method} answered HTTP ${status}`);
		this.final = status >= 400 && status < 500 && !PASSING_STATUSES.has(status);
	}
}

export async function speaksStateless(endpoint: Endpoint, signal?: AbortSignal): Promise<boolean | undefined> {
	const discovering = send(endpoint, "server/discover", undefined, {}, signal).catch((error: unknown) => {
		if (error instanceof HttpRefusal && error.final) return { error: error.message };
		throw error;
	});
	const response = await orLogged(discovering, "mcp.discover_failed", undefined, { url: endpoint.url });
	if (!response) return undefined;
	if ("error" in response) return false;
	const discovered = check(Discovered, response.result, "server/discover");
	return discovered.ok && discovered.value.supportedVersions.includes(STATELESS_VERSION);
}

export async function callTool(
	endpoint: Endpoint,
	name: string,
	args: Record<string, unknown>,
	ask: (request: FormRequest) => Promise<FormAnswer>,
	signal?: AbortSignal,
): Promise<CallToolResult> {
	let retry: { inputResponses: Record<string, FormAnswer>; requestState?: string } | undefined;
	for (let round = 0; round < MAX_ROUNDS; round++) {
		const response = await send(endpoint, "tools/call", name, { name, arguments: args, ...retry }, signal);
		if ("error" in response) throw new McpError(response.error.code, response.error.message, response.error.data);
		const input = check(InputRequired, response.result, "tools/call");
		if (!input.ok) {
			const result = check(ToolResult, response.result, "tools/call");
			if (!result.ok) throw new Error(result.problem);
			return result.value;
		}
		const inputResponses: Record<string, FormAnswer> = {};
		for (const [key, request] of Object.entries(input.value.inputRequests ?? {})) {
			const form = check(FormElicitation, request, "elicitation/create");
			if (!form.ok) throw new Error(`${name} asked for input pi cannot give (only form elicitation is supported): ${form.problem}`);
			inputResponses[key] = await ask({ message: form.value.params.message, schema: form.value.params.requestedSchema });
		}
		retry = { inputResponses, ...(input.value.requestState === undefined ? {} : { requestState: input.value.requestState }) };
	}
	throw new Error(`${name} kept asking for more input after ${MAX_ROUNDS} rounds`);
}

type Response = { result: unknown } | { error: { code: number; message: string; data?: unknown } };

async function send(endpoint: Endpoint, method: string, name: string | undefined, params: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
	const id = crypto.randomUUID();
	const body = JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: meta } });
	const post = async () => {
		const token = await endpoint.auth.token();
		const headers: Record<string, string> = {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"mcp-protocol-version": STATELESS_VERSION,
			"mcp-method": method,
			...(name === undefined ? {} : { "mcp-name": headerValue(name) }),
			...(token ? { authorization: `Bearer ${token}` } : {}),
		};
		return { response: await endpoint.fetch(endpoint.url, { method: "POST", headers, body, ...(signal ? { signal } : {}) }), token };
	};
	const first = await post();
	const refresh = endpoint.auth.onUnauthorized;
	const response =
		first.response.status === 401 && refresh
			? await refresh({ response: first.response, serverUrl: new URL(endpoint.url), fetch: endpoint.fetch, ...(first.token ? { token: first.token } : {}) }).then(post).then((again) => again.response)
			: first.response;
	if (!response.ok) throw new HttpRefusal(method, response.status);
	const text = await response.text();
	const message = (response.headers.get("content-type") ?? "").includes("text/event-stream") ? fromEvents(text, id) : jsonOrText(text);
	const parsed = parseJsonRpcMessage(message);
	if (!isJsonRpcResponse(parsed)) throw new Error(`MCP ${method} did not answer with a response`);
	return "error" in parsed ? { error: parsed.error } : { result: parsed.result };
}

function fromEvents(stream: string, id: string): unknown {
	const messages = stream
		.replaceAll("\r\n", "\n")
		.split("\n\n")
		.map((event) =>
			event
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trimStart())
				.join("\n"),
		)
		.filter(Boolean)
		.map(jsonOrText);
	return messages.find((message) => typeof message === "object" && message !== null && "id" in message && message.id === id);
}
