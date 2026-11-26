import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { type RawData, type WebSocket, WebSocketServer } from "ws";

export const KEY = "fixture-key";
const SOCKET_PATH = "/backend-api/codex/responses";

type Item = { type?: string; role?: string; content?: unknown; call_id?: string };
export type Frame = { bytes: number; previousResponseId: string | undefined; inputItems: number; toolOutputsFor: string[] };
const TOOL_ASK = "use the tool";

export type FakeProxy = {
	root: string;
	frames: Frame[];
	httpCalls: string[];
	identity: string;
	forgets: boolean;
	refusesSockets: boolean;
	dropSockets(): void;
	close(): void;
};

const textsOf = (items: Item[]) =>
	items
		.filter((item) => item.role === "user" && Array.isArray(item.content))
		.flatMap((item) => (Array.isArray(item.content) ? item.content : []))
		.flatMap((part: { type?: string; text?: string }) => (part.type === "input_text" && part.text ? [part.text] : []))
		.join(" ");

export async function fakeProxy(): Promise<FakeProxy> {
	const sockets = new WebSocketServer({ noServer: true });
	const http = createServer((request, response) => answerHttp(proxy, request, response));
	const proxy: FakeProxy = {
		root: "",
		frames: [],
		httpCalls: [],
		identity: "CLI Proxy API Server",
		forgets: false,
		refusesSockets: false,
		dropSockets: () => sockets.clients.forEach((socket) => socket.terminate()),
		close: () => {
			proxy.dropSockets();
			http.close();
		},
	};
	http.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => {
		const url = new URL(request.url ?? "/", "http://fixture");
		if (proxy.refusesSockets || url.pathname !== SOCKET_PATH || url.searchParams.get("key") !== KEY) {
			socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
			return;
		}
		sockets.handleUpgrade(request, socket, head, (open) => converse(proxy, open));
	});
	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	const address: AddressInfo | string | null = http.address();
	if (typeof address !== "object" || address === null) throw new Error("the fixture proxy has no port");
	proxy.root = `http://127.0.0.1:${address.port}`;
	return proxy;
}

function answerHttp(proxy: FakeProxy, request: IncomingMessage, response: ServerResponse): void {
	if (request.method === "GET" && request.url === "/") {
		response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ message: proxy.identity }));
		return;
	}
	proxy.httpCalls.push(`${request.method} ${request.url}`);
	request.resume();
	request.on("end", () => {
		const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(`${chunk({ role: "assistant", content: "plain" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`);
	});
}

function converse(proxy: FakeProxy, socket: WebSocket): void {
	const state: { input: Item[] | undefined; output: Item[]; turn: number } = { input: undefined, output: [], turn: 0 };
	socket.on("message", (data: RawData) => {
		const text = data.toString();
		const frame: { previous_response_id?: string; input?: Item[] } = JSON.parse(text);
		const input = frame.input ?? [];
		proxy.frames.push({ bytes: Buffer.byteLength(text), previousResponseId: frame.previous_response_id, inputItems: input.length, toolOutputsFor: input.flatMap((item) => (item.type === "function_call_output" && item.call_id ? [item.call_id] : [])) });
		if (frame.previous_response_id && !state.input) {
			socket.send(JSON.stringify({ type: "error", status: 400, error: { code: "previous_response_not_found", message: "Previous response is not available on this websocket" } }));
			return;
		}
		const history = frame.previous_response_id && !proxy.forgets ? [...(state.input ?? []), ...state.output, ...input] : input;
		state.turn += 1;
		const id = `resp_${state.turn}`;
		const reply = textsOf(input).includes(TOOL_ASK) ? toolCall(state.turn) : message(state.turn, textsOf(history));
		state.input = history;
		state.output = [reply.item];
		const events = [
			{ type: "response.created", response: { id, status: "in_progress" } },
			{ type: "response.output_item.added", output_index: 0, item: reply.started },
			...reply.deltas,
			{ type: "response.output_item.done", output_index: 0, item: reply.item },
			{ type: "response.completed", response: { id, status: "completed", usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 } } } },
		];
		for (const event of events) socket.send(JSON.stringify(event));
	});
}

function message(turn: number, text: string) {
	const item = { type: "message", id: `msg_${turn}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
	return { item, started: { ...item, content: [] }, deltas: [{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text }] };
}

function toolCall(turn: number) {
	const item = { type: "function_call", id: `fc_${turn}`, call_id: `call_${turn}`, name: "lookup", arguments: "{}", status: "completed" };
	return { item, started: { ...item, arguments: "" }, deltas: [{ type: "response.function_call_arguments.done", output_index: 0, arguments: "{}" }] };
}
