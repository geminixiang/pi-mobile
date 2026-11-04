import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Extension, ToolExecutionApi } from "@earendil-works/pi-durable";
import { McpClient } from "@earendil-works/pi-mcp";
import { extensionName, McpHub } from "../../src/agent/mcp.ts";
import { type Check, platform, settle } from "./setup.ts";

function server() {
	const state = { session: "", opened: 0, calls: 0 };
	const fetcher = async (_input: unknown, init?: RequestInit): Promise<Response> => {
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		const reply = (result: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json", ...headers } });
		if (body?.method === "server/discover") return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "unknown" } }), { headers: { "content-type": "application/json" } });
		if (body?.method === "initialize") {
			state.session = `session-${++state.opened}`;
			return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }, { "mcp-session-id": state.session });
		}
		if (new Headers(init?.headers).get("mcp-session-id") !== state.session) return new Response("gone", { status: 404 });
		if (body?.id === undefined) return new Response(null, { status: 202 });
		if (body.method === "tools/list") return reply({ tools: [{ name: "ping", description: "ping", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: {} } }, { name: "send", description: "send", inputSchema: { type: "object", properties: {} } }] });
		state.calls++;
		return reply({ content: [{ type: "text", text: "pong" }] });
	};
	return { state, fetcher };
}

// why: the tool reads only callId and conversationId from its api; a whole Harness is not what this check is about
const api = { callId: "call-1/1", conversationId: "bot-1" } as unknown as ToolExecutionApi;

export const checks: Check[] = [
	[
		"a session the server forgot opens a new one and the call goes through, so a restarted server needs no manual reconnect",
		async () => {
			platform.plain.remove("pi-mobile.mcp-servers");
			const { state, fetcher } = server();
			const installed = new Map<string, Extension>();
			const hub = new McpHub(
				{ ...platform, mcpClient: () => new McpClient({ name: "fixture", version: "1" }), mcpFetch: fetcher },
				{
					install: (extension) => void installed.set(extension.name, extension),
					uninstall: () => undefined,
					revoke: async () => undefined,
					openUrl: async () => undefined,
					hostKey: () => "",
					builtinTools: () => new Set(),
					ask: async () => ({ action: "cancel" }),
				},
			);
			try {
				const added = await hub.add("Service", "https://service.example/mcp");
				for (let tries = 0; tries < 50 && !installed.get(extensionName(added))?.tools?.length; tries++) await settle();
				const tool = installed.get(extensionName(added))?.tools?.find((candidate) => candidate.name.endsWith("ping"));
				assert(tool, "ping is installed");
				const run = () => tool.execute({}, api, BACKGROUND_CONTEXT);
				assert.match(JSON.stringify((await run()).output), /pong/);
				state.session = "forgotten";
				assert.match(JSON.stringify((await run()).output), /pong/);
				assert.equal(state.calls, 2, "the expired call never reached the tool, so it ran once");
				assert.equal(state.opened, 2);
				assert.match(JSON.stringify((await run()).output), /pong/);
				assert.equal(state.opened, 2, "the new session stays");
				assert.deepEqual(installed.get(extensionName(added))?.tools?.map((candidate) => [candidate.name.split("_").at(-1), candidate.replay]), [["ping", "safe"], ["send", "unsafe"]], "only a tool the service marks read-only is run again after a restart, so a send never goes out twice");
			} finally {
				await hub.close();
			}
		},
	],
];
