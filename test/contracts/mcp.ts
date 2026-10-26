import assert from "node:assert/strict";
import { extensionName } from "../../src/agent/mcp.ts";
import { agentState, keepOpen, openRuntime } from "./fixtures.ts";
import { type Check, deferred, mcp, openClients, platform, resetMcp, secrets, settle } from "./setup.ts";
import { MemoryStorage } from "@earendil-works/pi-durable";

const granted = (state: unknown, extension: string) => JSON.stringify(state ?? {}).includes(`"${extension}"`);

export const checks: Check[] = [
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
			const gate = deferred();
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
				const gate = deferred();
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
				const gate = deferred();
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
