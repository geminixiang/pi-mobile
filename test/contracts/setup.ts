import { mock } from "node:test";
import type { Settings } from "../../src/settings.ts";

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

export const logged: { level: string; event: string; fields: Record<string, unknown> }[] = [];
const record =
	(level: string) =>
	(event: string, fields: Record<string, unknown> = {}) =>
		void logged.push({ level, event, fields });
mock.module(new URL("../../src/log.ts", import.meta.url).href, { namedExports: { log: { info: record("info"), warn: record("warn"), error: record("error") } } });

export function deferred<T = void>() {
	let resolve: (value: T) => void = () => undefined;
	let reject: (error: Error) => void = () => undefined;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

type Gate = { promise: Promise<void> } | undefined;

class FakeMcpClient {
	closed = false;
	readonly #closeListeners: (() => void)[] = [];
	readonly #closing = deferred();
	constructor() {
		mcp.clients.push(this);
	}
	async #wait(gate: Gate): Promise<void> {
		await Promise.race([gate?.promise, this.#closing.promise]);
		if (this.closed) throw new Error("MCP client is closed");
	}
	async connect(): Promise<void> {
		await this.#wait(mcp.connectGate);
	}
	async listTools() {
		await this.#wait(mcp.listGate);
		if (mcp.listFails) throw new Error("tools/list failed");
		return [{ name: "fixture", description: "A contract fixture, never called.", inputSchema: { type: "object", properties: {} } }];
	}
	onClose(listener: () => void): void {
		this.#closeListeners.push(listener);
	}
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.#closing.resolve();
		for (const listener of this.#closeListeners) listener();
	}
}

type McpFixture = { clients: FakeMcpClient[]; connectGate: Gate; listGate: Gate; listFails: boolean };

export const mcp: McpFixture = { clients: [], connectGate: undefined, listGate: undefined, listFails: false };

export function resetMcp(): void {
	mcp.clients.length = 0;
	mcp.connectGate = undefined;
	mcp.listGate = undefined;
	mcp.listFails = false;
}

export const openClients = () => mcp.clients.filter((client) => !client.closed).length;

const mcpModule = new URL("../../node_modules/@earendil-works/pi-mcp/dist/index.js", import.meta.url).href;
mock.module(mcpModule, { namedExports: { ...(await import(mcpModule)), McpClient: FakeMcpClient } });

export const secrets: { removeGate: Gate } = { removeGate: undefined };
mock.module(new URL("../../node_modules/@aparajita/capacitor-secure-storage/dist/esm/index.js", import.meta.url).href, {
	namedExports: {
		SecureStorage: {
			keys: async () => {
				await secrets.removeGate?.promise;
				return [];
			},
			remove: async () => undefined,
			get: async () => null,
			set: async () => undefined,
		},
	},
});

export const folders: { removeGate: Gate; removed: string[] } = { removeGate: undefined, removed: [] };
const phoneEnv = new URL("../../src/agent/files/phone-env.ts", import.meta.url).href;
mock.module(phoneEnv, {
	namedExports: {
		...(await import(phoneEnv)),
		removePhoneFolder: async (bot: string) => {
			folders.removed.push(bot);
			await folders.removeGate?.promise;
		},
	},
});

const { createModels, fauxProvider } = await import("@earendil-works/pi-ai");
export const faux = fauxProvider({ provider: "faux", models: [{ id: "model" }] });
const { memoryCredentials } = await import("../../src/agent/credentials.ts");
mock.module(new URL("../../src/agent/available-models.ts", import.meta.url).href, {
	namedExports: {
		startModelList: () => Promise.resolve({}),
		loadModels: async () => {
			const models = createModels({ credentials: memoryCredentials({ faux: "contract" }, {}, () => undefined) });
			models.setProvider(faux.provider);
			return { models, infos: [], lists: {}, webSearch: { baseUrl: "", apiKey: "", modelIds: [] } };
		},
	},
});

export const settings: Settings = {
	providers: "[]",
	providerKeys: {},
	providerOAuth: {},
	githubToken: "",
	gcloudCredential: "",
	gcloudProject: "",
	cloudflareCredential: "",
	azureCredential: "",
	defaultProvider: "faux",
	defaultModelId: "model",
	defaultThinking: "off",
	calendarAccess: "",
	hosts: "",
	computer: "",
	compactAt: 256_000,
};

export const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

export type Check = [string, () => Promise<void>];
