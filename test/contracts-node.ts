import assert from "node:assert/strict";
import { mock } from "node:test";
import type { Settings } from "../src/settings.ts";

const stored = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
	value: {
		getItem: (key: string) => stored.get(key) ?? null,
		setItem: (key: string, value: string) => stored.set(key, String(value)),
		removeItem: (key: string) => stored.delete(key),
		clear: () => stored.clear(),
	},
	configurable: true,
});
globalThis.fetch = async () => {
	throw new Error("contracts run offline");
};

const mcpModule = new URL("../node_modules/@earendil-works/pi-mcp/dist/index.js", import.meta.url).href;
const realMcp = await import(mcpModule);
const mcpClients: FakeMcpClient[] = [];
class FakeMcpClient {
	closed = false;
	readonly #closeListeners: (() => void)[] = [];
	constructor() {
		mcpClients.push(this);
	}
	async connect(): Promise<void> {}
	async listTools() {
		return [{ name: "fixture", description: "A contract fixture, never called.", inputSchema: { type: "object", properties: {} } }];
	}
	onClose(listener: () => void): void {
		this.#closeListeners.push(listener);
	}
	async close(): Promise<void> {
		this.closed = true;
		for (const listener of this.#closeListeners) listener();
	}
}
mock.module(mcpModule, { namedExports: { ...realMcp, McpClient: FakeMcpClient } });
mock.module(new URL("../node_modules/@aparajita/capacitor-secure-storage/dist/esm/index.js", import.meta.url).href, {
	namedExports: { SecureStorage: { keys: async () => [], remove: async () => undefined, get: async () => null, set: async () => undefined } },
});

const { Computers } = await import("../src/agent/computers.ts");
const { AgentRuntime } = await import("../src/agent/runtime.ts");
const { extensionName } = await import("../src/agent/mcp.ts");
const { MemoryStorage } = await import("@earendil-works/pi-durable");
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const settings: Settings = {
	providers: "[]",
	providerKeys: {},
	providerOAuth: {},
	githubToken: "",
	gcloudCredential: "",
	gcloudProject: "",
	cloudflareCredential: "",
	azureCredential: "",
	defaultProvider: "",
	defaultModelId: "",
	defaultThinking: "low",
	calendarAccess: "",
	hosts: "",
	computer: "",
	compactAt: 256_000,
};

const checks: [string, () => Promise<void> | void][] = [];
const check = (name: string, run: () => Promise<void> | void) => checks.push([name, run]);

check("a bot whose computer was removed does not move to another computer", () => {
	const host = { id: "b.example", address: "b.example", name: "B", os: "linux", arch: "arm64", user: "fixture", home: "/home/fixture" };
	const computers = new Computers({ ...settings, hosts: JSON.stringify([host]), computer: "b.example:direct" }, {});
	assert.deepEqual(computers.resolve("a.example:container"), { kind: "missing", key: "a.example:container" });
	assert.equal(computers.sandboxAt(computers.resolve("a.example:container")), undefined);
	const inherited = computers.resolve(undefined);
	assert.equal(inherited.kind === "ready" && inherited.computer.key, "b.example:direct");
	const chosen = computers.resolve("phone");
	assert.equal(chosen.kind === "ready" && chosen.computer.key, "phone");
});

check("a removed MCP service takes its bots' grants and connection with it", async () => {
	mcpClients.length = 0;
	const runtime = await AgentRuntime.open(new MemoryStorage(), settings, { modelIds: Promise.resolve({}) });
	try {
		const [bot] = await runtime.bots();
		assert(bot);
		const original = await runtime.mcp.add("Work", "https://old.invalid/mcp");
		await settle();
		await runtime.setToolset(bot.id, extensionName(original), true);
		assert.equal((await runtime.toolsets(bot.id)).find((item) => item.id === extensionName(original))?.enabled, true);
		await runtime.mcp.remove(original.id);
		assert.equal(mcpClients[0]?.closed, true);
		const replacement = await runtime.mcp.add("Work", "https://new.invalid/mcp");
		await settle();
		assert.equal(replacement.id, original.id);
		assert.equal((await runtime.toolsets(bot.id)).find((item) => item.id === extensionName(replacement))?.enabled, false);
	} finally {
		await runtime.close();
	}
	assert.equal(mcpClients.filter((client) => !client.closed).length, 0);
});

check("a new MCP service is given to no bot, even over a grant its name left behind", async () => {
	const memory = new MemoryStorage();
	const storage = new Proxy(memory, {
		get(target, key) {
			if (key === "close") return async () => undefined;
			const value: unknown = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const before = await AgentRuntime.open(storage, settings, { modelIds: Promise.resolve({}) });
	const [bot] = await before.bots();
	assert(bot);
	const first = await before.mcp.add("Notes", "https://notes.invalid/mcp");
	await settle();
	await before.setToolset(bot.id, extensionName(first), true);
	await before.close();
	localStorage.setItem("pi-mobile.mcp-servers", "[]");
	const after = await AgentRuntime.open(storage, settings, { modelIds: Promise.resolve({}) });
	try {
		const second = await after.mcp.add("Notes", "https://other.invalid/mcp");
		await settle();
		assert.equal(second.id, first.id);
		assert.equal((await after.toolsets(bot.id)).find((item) => item.id === extensionName(second))?.enabled, false);
	} finally {
		await after.close();
	}
});

const failures: string[] = [];
for (const [name, run] of checks) {
	try {
		await run();
	} catch (error) {
		failures.push(`${name}\n  ${error instanceof Error ? error.message : String(error)}`);
	}
}
if (failures.length > 0) {
	console.error(`contracts: ${failures.length} of ${checks.length} failed\n${failures.join("\n")}`);
	process.exit(1);
}
console.log(`contracts: ${checks.length} hold`);
