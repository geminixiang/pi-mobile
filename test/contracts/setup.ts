import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { memoryCredentials } from "../../src/agent/credentials.ts";
import { PhoneEnv } from "../../src/agent/files/phone-env.ts";
import type { McpSession, Platform } from "../../src/agent/platform.ts";
import type { Settings } from "../../src/settings.ts";
import { DEFAULT_CALENDAR_ACCESS } from "../../src/agent/calendar-access.ts";

globalThis.fetch = async () => {
	throw new Error("contracts run offline");
};

export const logged: { level: string; event: string; fields: Record<string, unknown> }[] = [];
for (const level of ["info", "warn", "error"] as const) {
	console[level] = (line: unknown) => {
		if (typeof line !== "string" || !line.startsWith("{")) return;
		const { event, ...fields } = JSON.parse(line);
		logged.push({ level, event, fields });
	};
}

type Gate = { promise: Promise<void> } | undefined;

class FakeMcpClient implements McpSession {
	closed = false;
	readonly serverInfo = undefined;
	readonly instructions = undefined;
	readonly #closeListeners: (() => void)[] = [];
	readonly #closing = Promise.withResolvers<void>();
	constructor() {
		mcp.clients.push(this);
	}
	async #wait(gate: Gate): Promise<void> {
		await Promise.race([gate?.promise, this.#closing.promise]);
		if (this.closed) throw new Error("MCP client is closed");
	}
	async connect() {
		await this.#wait(mcp.connectGate);
		return { protocolVersion: "contract", capabilities: {}, serverInfo: { name: "fixture", version: "0" } };
	}
	async listTools() {
		await this.#wait(mcp.listGate);
		if (mcp.listFails) throw new Error("tools/list failed");
		return [{ name: "fixture", description: "A contract fixture, never called.", inputSchema: { type: "object", properties: {} } }];
	}
	callTool(): never {
		throw new Error("contract fixtures are never called");
	}
	onClose(listener: () => void): () => void {
		this.#closeListeners.push(listener);
		return () => void this.#closeListeners.splice(this.#closeListeners.indexOf(listener), 1);
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

export const secrets: { removeGate: Gate } = { removeGate: undefined };

export const folders: { removeGate: Gate; removed: string[] } = { removeGate: undefined, removed: [] };

export const faux = fauxProvider({ provider: "faux", models: [{ id: "model" }] });

const plain = new Map<string, string>();

export const platform: Platform = {
	inApp: true,
	// why: the database section reads the real plugin, which Node does not have
	native: { has: (plugin) => plugin !== "Database", implements: ({ plugin }) => plugin !== "Database" },
	plain: {
		get: (key) => plain.get(key) ?? null,
		set: (key, value) => void plain.set(key, value),
		remove: (key) => void plain.delete(key),
	},
	secrets: {
		keys: async () => [],
		get: async () => undefined,
		set: async () => undefined,
		remove: async () => {
			await secrets.removeGate?.promise;
		},
	},
	rotated: { cloudflare: async () => undefined, azure: async () => undefined },
	mcpClient: () => new FakeMcpClient(),
	phone: {
		folder: (folder, network) => new PhoneEnv(folder, network),
		removeFolder: async (folder) => {
			folders.removed.push(folder);
			await folders.removeGate?.promise;
		},
	},
	models: async () => {
		const models = createModels({ credentials: memoryCredentials({ faux: "contract" }, {}, () => undefined) });
		models.setProvider(faux.provider);
		return { models, infos: [], webSearch: { baseUrl: "", apiKey: "", modelIds: [] } };
	},
};

export const settings: Settings = {
	providers: [],
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
	calendarAccess: DEFAULT_CALENDAR_ACCESS,
	hosts: [],
	hostKeys: {},
	computer: "",
	compactAt: 256_000,
};

export const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

export type Check = [string, () => Promise<void>];
