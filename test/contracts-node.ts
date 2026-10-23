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
const { createRegistry, Harness, MemoryStorage } = await import("@earendil-works/pi-durable");
const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
const { loadModels } = await import("../src/agent/available-models.ts");
const { TRIGGER_ENTRY, TriggerDoc, TriggerRuns } = await import("../src/agent/triggers.ts");
type When = import("../src/agent/triggers.ts").Trigger["when"];
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

check("a removed bot is gone from the list with its schedules and memory", async () => {
	const runtime = await AgentRuntime.open(new MemoryStorage(), settings, { modelIds: Promise.resolve({}) });
	try {
		const [keep] = await runtime.bots();
		assert(keep);
		const gone = await runtime.createBot({ name: "tmp", job: "", avatar: "helper" });
		await runtime.removeBot(gone);
		assert.deepEqual((await runtime.bots()).map((bot) => bot.id), [keep.id]);
		assert.deepEqual(await runtime.memory({ kind: "bot", id: gone }), { text: "", updatedAt: 0, updatedBy: "" });
		await assert.rejects(runtime.removeBot(keep.id), /至少要留一個 Bot/);
	} finally {
		await runtime.close();
	}
});

async function triggerFixture(when: When, enabled = true) {
	const storage = new MemoryStorage();
	const { models } = await loadModels(settings, Promise.resolve({}));
	const harness = await Harness.open(storage, { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
	const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
	await harness.commit(async (tx) => {
		(await tx.doc(TriggerDoc)).items.push({ id: "t1", name: "fixture", prompt: "fixture", when, kind: "schedule", conversationId: conversation.id, enabled, createdAt: Date.now() });
	}, BACKGROUND_CONTEXT);
	let failSubmit = false;
	const flaky = new Proxy(harness, {
		get(target, key) {
			if (key === "conversation")
				return async (...args: Parameters<typeof target.conversation>) => {
					const found = await target.conversation(...args);
					if (!found || !failSubmit) return found;
					return new Proxy(found, {
						get(inner, name) {
							if (name === "submit") return async () => Promise.reject(new Error("submission refused"));
							const value: unknown = Reflect.get(inner, name, inner);
							return typeof value === "function" ? value.bind(inner) : value;
						},
					});
				};
			const value: unknown = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const runs = new TriggerRuns(flaky, async () => [{ id: conversation.id, avatar: "helper" }], async () => undefined);
	const doc = async () => (await harness.snapshot(TriggerDoc, BACKGROUND_CONTEXT)) ?? { items: [], runs: [] };
	const delivered = async () => {
		const page = await storage.scanEntries({ conversationId: conversation.id }, 100, undefined, BACKGROUND_CONTEXT);
		return page.items.filter((entry) => entry.kind === TRIGGER_ENTRY).length;
	};
	return { runs, doc, delivered, refuse: (refuse: boolean) => (failSubmit = refuse), close: () => harness.close(BACKGROUND_CONTEXT) };
}

check("a one-time schedule whose input was refused is still there to retry", async () => {
	const fixture = await triggerFixture({ kind: "once", at: Date.now() - 1000 });
	try {
		fixture.refuse(true);
		await assert.rejects(fixture.runs.run("t1", "live", { event: "e1" }), /submission refused/);
		assert.equal((await fixture.doc()).items.length, 1);
		assert.equal((await fixture.doc()).runs.length, 0);
		fixture.refuse(false);
		assert.ok(await fixture.runs.run("t1", "later", { event: "e1" }));
		assert.equal((await fixture.doc()).items.length, 0);
		assert.equal((await fixture.doc()).runs.length, 1);
		assert.equal(await fixture.delivered(), 1);
	} finally {
		await fixture.close();
	}
});

check("an event delivered twice is one input and one run", async () => {
	const fixture = await triggerFixture({ kind: "daily", time: "08:00", days: [] });
	try {
		await fixture.runs.run("t1", "live", { event: "e1" });
		await fixture.runs.run("t1", "live", { event: "e1" });
		assert.equal(await fixture.delivered(), 1);
		assert.equal((await fixture.doc()).runs.length, 1);
	} finally {
		await fixture.close();
	}
});

check("an event queued before its schedule was paused does not run", async () => {
	const fixture = await triggerFixture({ kind: "daily", time: "08:00", days: [] }, false);
	try {
		assert.equal(await fixture.runs.run("t1", "later", { event: "e1" }), undefined);
		assert.equal(await fixture.delivered(), 0);
		assert.ok(await fixture.runs.run("t1", "manual"));
	} finally {
		await fixture.close();
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
