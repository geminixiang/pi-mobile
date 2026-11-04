import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Extension, ToolExecutionApi } from "@earendil-works/pi-durable";
import { extensionName, McpHub } from "../../src/agent/mcp.ts";
import type { AgentRuntime, ConversationId } from "../../src/agent/runtime.ts";
import type { Forms } from "../../src/interaction/forms.ts";
import { openRuntime } from "./fixtures.ts";
import { type Check, mcp, mcpHttp, platform, resetMcp, settle } from "./setup.ts";

const URL_ = "https://mail.example/mcp";
const KEY = "confirm_send_1";

type Seen = { method: string; headers: Record<string, string>; params: Record<string, unknown> };

function statelessServer(seen: Seen[]) {
	return (init?: RequestInit): Response => {
		const body = JSON.parse(String(init?.body));
		const headers = Object.fromEntries(Object.entries(init?.headers ?? {}));
		seen.push({ method: body.method, headers, params: body.params });
		const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json" } });
		if (body.method === "server/discover") return reply({ resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} } });
		const answer = body.params.inputResponses?.[KEY];
		if (!answer) {
			return reply({
				resultType: "input_required",
				inputRequests: {
					[KEY]: {
						method: "elicitation/create",
						params: { mode: "form", message: "To: a@example.com\nSubject: hello", requestedSchema: { type: "object", properties: { send: { type: "boolean", title: "Send this email" } }, required: ["send"] } },
					},
				},
				requestState: "opaque-1",
			});
		}
		const sent = answer.action === "accept" && answer.content?.send === true && body.params.requestState === "opaque-1";
		return reply({ content: [{ type: "text", text: sent ? "sent" : "not_sent" }] });
	};
}

async function sendDraftTool(runtime: AgentRuntime, bot: ConversationId) {
	resetMcp();
	mcp.toolNames = ["send_draft"];
	platform.plain.remove("pi-mobile.mcp-servers");
	const installed = new Map<string, Extension>();
	const forms = runtime.forms;
	const hub = new McpHub(platform, {
		install: (extension) => void installed.set(extension.name, extension),
		uninstall: () => undefined,
		revoke: async () => undefined,
		openUrl: async () => undefined,
		hostKey: () => "",
		builtinTools: () => new Set(),
		ask: (callId, form, signal) => forms.ask(callId, form, signal),
	});
	const server = await hub.add("Mail", URL_);
	await settle();
	const tool = installed.get(extensionName(server))?.tools?.find((candidate) => candidate.name === `${server.id}_send_draft`);
	assert(tool, "send_draft is installed");
	// why: the tool reads only callId and conversationId from its api; a whole Harness is not what this check is about
	const api = { callId: "call-1/1", conversationId: bot } as unknown as ToolExecutionApi;
	return { hub, forms, run: () => tool.execute({ mailbox: "me", draft_id: "d1" }, api, BACKGROUND_CONTEXT) };
}

async function pendingForm(forms: Forms) {
	for (let tries = 0; tries < 50 && !forms.state.pending.has("call-1/1"); tries++) await settle();
	const form = forms.state.pending.get("call-1/1");
	assert(form, "the send waits for the user's confirmation");
	return form;
}

export const checks: Check[] = [
	[
		"a send the mail service gates behind a confirmation waits for the user's tap, then goes out with the same request state",
		async () => {
			const seen: Seen[] = [];
			mcpHttp.routes = { [`POST ${URL_}`]: statelessServer(seen) };
			const { runtime } = await openRuntime();
			const bot = await runtime.createBot({ name: "tmp", job: "", avatar: "helper" });
			const { hub, forms, run } = await sendDraftTool(runtime, bot);
			try {
				const result = run();
				const form = await pendingForm(forms);
				assert.equal(form.service, "Mail");
				assert.match(form.request.message, /a@example\.com/);
				forms.answer("call-1/1", { action: "accept", content: { send: true } });
				assert.match(JSON.stringify((await result).output), /"sent"/);
				const calls = seen.filter((request) => request.method === "tools/call");
				assert.equal(calls.length, 2);
				assert.equal(calls[0]?.headers["mcp-protocol-version"], "2026-07-28");
				assert.equal(calls[0]?.headers["mcp-name"], "send_draft");
				assert.deepEqual(calls[0]?.params._meta, {
					"io.modelcontextprotocol/protocolVersion": "2026-07-28",
					"io.modelcontextprotocol/clientInfo": { name: "pi-mobile", version: "1.0.0" },
					"io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
				});
				assert.equal(calls[1]?.params.requestState, "opaque-1");
				assert.equal(forms.state.pending.size, 0);
				await settle();
				await forms.load(bot);
				const settled = forms.state.settled.get(String(bot)) ?? [];
				assert.deepEqual(settled.map((record) => [record.step, record.outcome]), [["call-1", "accepted"]], "the outcome is kept in the conversation, under the step the script ran in");
			} finally {
				mcpHttp.routes = {};
				await hub.close();
				await runtime.close();
			}
		},
	],
	[
		"a discovery that failed is asked again on the next call, so one network error does not end confirmations until a reconnect",
		async () => {
			const seen: Seen[] = [];
			const server = statelessServer(seen);
			let down = true;
			mcpHttp.routes = {
				[`POST ${URL_}`]: (init) => {
					if (down && JSON.parse(String(init?.body)).method === "server/discover") throw new Error("network down");
					return server(init);
				},
			};
			const { runtime } = await openRuntime();
			const bot = await runtime.createBot({ name: "tmp", job: "", avatar: "helper" });
			const { hub, forms, run } = await sendDraftTool(runtime, bot);
			try {
				await assert.rejects(run(), /never called/);
				down = false;
				const result = run();
				await pendingForm(forms);
				forms.answer("call-1/1", { action: "accept", content: { send: true } });
				assert.match(JSON.stringify((await result).output), /"sent"/);
				await settle();
			} finally {
				mcpHttp.routes = {};
				await hub.close();
				await runtime.close();
			}
		},
	],
	[
		"declining the confirmation sends nothing, and the bot is told so",
		async () => {
			mcpHttp.routes = { [`POST ${URL_}`]: statelessServer([]) };
			const { runtime } = await openRuntime();
			const bot = await runtime.createBot({ name: "tmp", job: "", avatar: "helper" });
			const { hub, forms, run } = await sendDraftTool(runtime, bot);
			try {
				const result = run();
				await pendingForm(forms);
				forms.answer("call-1/1", { action: "decline" });
				assert.match(JSON.stringify((await result).output), /not_sent/);
			} finally {
				mcpHttp.routes = {};
				await hub.close();
				await runtime.close();
			}
		},
	],
	[
		"typing while a confirmation waits skips it: nothing is sent, and the card says it was skipped",
		async () => {
			mcpHttp.routes = { [`POST ${URL_}`]: statelessServer([]) };
			const { runtime } = await openRuntime();
			const bot = await runtime.createBot({ name: "tmp", job: "", avatar: "helper" });
			const { hub, forms, run } = await sendDraftTool(runtime, bot);
			try {
				const declined = run();
				await pendingForm(forms);
				forms.answer("call-1/1", { action: "decline" });
				await declined;
				await settle();
				const result = run();
				await pendingForm(forms);
				forms.skip(bot);
				assert.match(JSON.stringify((await result).output), /not_sent/);
				await settle();
				assert.deepEqual((forms.state.settled.get(String(bot)) ?? []).map((record) => record.outcome), ["declined", "skipped"], "earlier records stay readable after a later one is written");
			} finally {
				mcpHttp.routes = {};
				await hub.close();
				await runtime.close();
			}
		},
	],
];
