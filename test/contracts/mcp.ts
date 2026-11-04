import assert from "node:assert/strict";
import { extensionName } from "../../src/agent/mcp.ts";
import { agentState, keepOpen, openRuntime } from "./fixtures.ts";
import { type Check, mcp, mcpHttp, openClients, platform, resetMcp, secrets, settings, settle } from "./setup.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { createRegistry, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { memoryCredentials } from "../../src/agent/credentials.ts";
import { AgentRuntime } from "../../src/agent/runtime.ts";
import { turn } from "./fixtures.ts";

const granted = (state: unknown, extension: string) => JSON.stringify(state ?? {}).includes(`"${extension}"`);

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const checks: Check[] = [
	[
		"signing in to a service behind Cloudflare Access reads the resource metadata its 401 names, not the well-known path that redirects to a login page",
		async () => {
			resetMcp();
			platform.plain.remove("pi-mobile.mcp-servers");
			const metadata = "https://mail.example/.well-known/cloudflare-access-protected-resource/mcp";
			const team = "https://team.example";
			mcpHttp.requests.length = 0;
			mcpHttp.routes = {
				"POST https://mail.example/mcp": () => new Response("", { status: 401, headers: { "www-authenticate": `Bearer realm="OAuth", error="invalid_token", resource_metadata="${metadata}"` } }),
				"GET https://mail.example/.well-known/oauth-protected-resource/mcp": () => new Response("<!DOCTYPE html><title>Sign in</title>", { status: 302, headers: { "content-type": "text/html" } }),
				[`GET ${metadata}`]: json({ resource: "https://mail.example/mcp", authorization_servers: [team] }),
				[`GET ${team}/.well-known/oauth-authorization-server`]: json({
					issuer: team,
					authorization_endpoint: `${team}/cdn-cgi/access/oauth/authorization`,
					token_endpoint: `${team}/cdn-cgi/access/oauth/token`,
					registration_endpoint: `${team}/cdn-cgi/access/oauth/registration`,
					response_types_supported: ["code"],
					grant_types_supported: ["authorization_code", "refresh_token"],
					token_endpoint_auth_methods_supported: ["none"],
					code_challenge_methods_supported: ["S256"],
				}),
				[`POST ${team}/cdn-cgi/access/oauth/registration`]: json({ client_id: "pi", redirect_uris: ["http://127.0.0.1:47823/oauth/mcp"], token_endpoint_auth_method: "none" }, 201),
			};
			const opened: string[] = [];
			const runtime = await AgentRuntime.open(new MemoryStorage(), settings, platform, { openUrl: async (url) => void opened.push(url) });
			try {
				const server = await runtime.mcp.add("Mail", "https://mail.example/mcp");
				await runtime.mcp.login(server.id);
				assert.equal(opened.length, 1, `requests: ${mcpHttp.requests.join(", ")}`);
				assert(opened[0]?.startsWith(`${team}/cdn-cgi/access/oauth/authorization?`), opened[0]);
			} finally {
				mcpHttp.routes = {};
				await runtime.close();
			}
		},
	],
	[
		"a service named like a built-in tool gets its own id, so adding it leaves the built-in tools a bot loaded",
		async () => {
			resetMcp();
			platform.plain.remove("pi-mobile.mcp-servers");
			const storage = keepOpen(new MemoryStorage());
			const first = await openRuntime(storage);
			const [bot] = await first.runtime.bots();
			assert(bot);
			await first.runtime.close();
			const raw = await Harness.open(storage, { models: createModels({ credentials: memoryCredentials({}, {}, () => undefined) }), registry: createRegistry(), settings: { extensions: [] } }, BACKGROUND_CONTEXT);
			const loaded = defineTool({ name: "phone_read_as_user", description: "loaded", parameters: Type.Object({}), execute: async () => ({ output: [] }) });
			await (await raw.conversation(bot.id, BACKGROUND_CONTEXT))?.configure({ modelTools: { add: [loaded] } }, BACKGROUND_CONTEXT);
			await raw.close(BACKGROUND_CONTEXT);
			const { runtime } = await openRuntime(storage);
			try {
				const server = await runtime.mcp.add("Phone", "https://phone.invalid/mcp");
				await settle();
				assert.notEqual(server.id, "phone");
				assert.match(JSON.stringify(await agentState(runtime, bot.id)), /phone_read_as_user/);
			} finally {
				await runtime.close();
			}
		},
	],
	[
		"a stored service whose tool shares a built-in tool's name does not replace it, and its status says so",
		async () => {
			resetMcp();
			platform.plain.set("pi-mobile.mcp-servers", JSON.stringify([{ id: "web", name: "Web", url: "https://web.invalid/mcp" }]));
			mcp.toolNames = ["fetch", "lookup"];
			const { runtime } = await openRuntime();
			try {
				const [bot] = await runtime.bots();
				assert(bot);
				runtime.mcp.refresh("web");
				await settle(300);
				assert.deepEqual(runtime.mcp.status("web")?.shadowed, ["web_fetch"]);
				await runtime.setToolset(bot.id, extensionName({ id: "web", name: "Web", url: "https://web.invalid/mcp" }), true);
				let offered = "";
				await turn(runtime, bot.id, [
					(context: TranscriptContext) => {
						offered = JSON.stringify(context);
						return fauxAssistantMessage("done");
					},
				]);
				assert.match(offered, /web_lookup/);
				assert.match(offered, /web_fetch\([^)]*save_to/);
			} finally {
				platform.plain.remove("pi-mobile.mcp-servers");
				await runtime.close();
			}
		},
	],
	[
		"removing an MCP service revokes it from every bot and closes its client",
		async () => {
			resetMcp();
			const { runtime } = await openRuntime();
			try {
				const [bot] = await runtime.bots();
				assert(bot);
				const server = await runtime.mcp.add("Work", "https://old.invalid/mcp");
				await settle();
				await runtime.setToolset(bot.id, extensionName(server), true);
				assert.equal(granted(await agentState(runtime, bot.id), extensionName(server)), true);
				await runtime.mcp.remove(server.id);
				assert.equal(granted(await agentState(runtime, bot.id), extensionName(server)), false);
				assert.equal(openClients(), 0);
			} finally {
				await runtime.close();
			}
		},
	],
	[
		"a new MCP service is given to no bot, even over a grant its name left behind",
		async () => {
			resetMcp();
			const storage = keepOpen(new MemoryStorage());
			const before = await openRuntime(storage);
			const [bot] = await before.runtime.bots();
			assert(bot);
			const first = await before.runtime.mcp.add("Notes", "https://notes.invalid/mcp");
			await settle();
			await before.runtime.setToolset(bot.id, extensionName(first), true);
			await before.runtime.close();
			platform.plain.remove("pi-mobile.mcp-servers");
			const after = await openRuntime(storage);
			try {
				const second = await after.runtime.mcp.add("Notes", "https://other.invalid/mcp");
				await settle();
				assert.equal(second.id, first.id);
				assert.equal((await after.runtime.toolsets(bot.id)).find((item) => item.id === extensionName(second))?.enabled, false);
			} finally {
				await after.runtime.close();
			}
		},
	],
	[
		"two services added at once with the same name both stay, each with its own id",
		async () => {
			resetMcp();
			platform.plain.remove("pi-mobile.mcp-servers");
			const { runtime } = await openRuntime();
			try {
				const [a, b] = await Promise.all([runtime.mcp.add("Work", "https://a.invalid/mcp"), runtime.mcp.add("Work", "https://b.invalid/mcp")]);
				await settle();
				assert.notEqual(a.id, b.id);
				assert.deepEqual(runtime.mcp.servers.map((server) => server.url).sort(), ["https://a.invalid/mcp", "https://b.invalid/mcp"]);
			} finally {
				await runtime.close();
			}
			assert.equal(openClients(), 0);
		},
	],
	[
		"a connection still opening when the runtime closes is closed when it arrives",
		async () => {
			resetMcp();
			platform.plain.remove("pi-mobile.mcp-servers");
			const { runtime } = await openRuntime();
			const gate = Promise.withResolvers<void>();
			const server = await runtime.mcp.add("Slow", "https://slow.invalid/mcp");
			await settle();
			mcp.connectGate = gate;
			runtime.mcp.refresh(server.id);
			await settle();
			await runtime.close();
			gate.resolve();
			await settle();
			assert.equal(openClients(), 0);
			assert.notEqual(runtime.mcp.status(server.id)?.state, "ready");
		},
	],
	[
		"a connection replaced while it lists its tools does not publish them",
		async () => {
			resetMcp();
			platform.plain.remove("pi-mobile.mcp-servers");
			const { runtime } = await openRuntime();
			try {
				const gate = Promise.withResolvers<void>();
				mcp.listGate = gate;
				const server = await runtime.mcp.add("Listing", "https://list.invalid/mcp");
				await settle();
				await runtime.mcp.remove(server.id);
				gate.resolve();
				await settle();
				assert.equal(runtime.mcp.status(server.id), undefined);
				assert.equal(openClients(), 0);
			} finally {
				await runtime.close();
			}
		},
	],
	[
		"a service whose tool list fails shows the error and closes its client",
		async () => {
			resetMcp();
			platform.plain.remove("pi-mobile.mcp-servers");
			const { runtime } = await openRuntime();
			try {
				mcp.listFails = true;
				const server = await runtime.mcp.add("Broken", "https://broken.invalid/mcp");
				await settle();
				assert.equal(runtime.mcp.status(server.id)?.state, "error");
				assert.equal(openClients(), 0);
			} finally {
				await runtime.close();
			}
		},
	],
	[
		"a service being removed cannot be granted again before it is gone",
		async () => {
			resetMcp();
			platform.plain.remove("pi-mobile.mcp-servers");
			const { runtime } = await openRuntime();
			try {
				const [bot] = await runtime.bots();
				assert(bot);
				const server = await runtime.mcp.add("Work", "https://work.invalid/mcp");
				await settle();
				const gate = Promise.withResolvers<void>();
				secrets.removeGate = gate;
				const removing = runtime.mcp.remove(server.id);
				await settle();
				await assert.rejects(runtime.setToolset(bot.id, extensionName(server), true));
				secrets.removeGate = undefined;
				gate.resolve();
				await removing;
				assert.equal(granted(await agentState(runtime, bot.id), extensionName(server)), false);
			} finally {
				await runtime.close();
			}
		},
	],
];
