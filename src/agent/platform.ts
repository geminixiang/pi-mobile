import { SecureStorage } from "@aparajita/capacitor-secure-storage";
import { CapacitorHttp } from "@capacitor/core";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { McpClient, type McpFetch } from "@earendil-works/pi-mcp";
import { saveAzureCredential, saveCloudflareCredential, type Settings } from "../settings.ts";
import { loadModels, type LoadedModels } from "./available-models.ts";
import type { FolderNetwork } from "./files/folder-network.ts";
import { PhoneEnv, removePhoneFolder } from "./files/phone-env.ts";
import { refuseCleartextSecret } from "./cleartext.ts";
import { inApp, type Native, native } from "../native.ts";
import { headerRecord, NULL_BODY_STATUS } from "../http.ts";

export type McpSession = Pick<McpClient, "connect" | "listTools" | "callTool" | "onClose" | "close" | "serverInfo" | "instructions">;

export interface PhoneApp {
	folder(folder: string, network: FolderNetwork): ExecutionEnv;
	removeFolder(folder: string): Promise<void>;
}

export type RotatedCredentials = { cloudflare(json: string): Promise<void>; azure(json: string): Promise<void> };

export interface Platform {
	inApp: boolean;
	native: Native;
	phone: PhoneApp | undefined;
	plain: { get(key: string): string | null; set(key: string, value: string): void; remove(key: string): void };
	secrets: { keys(): Promise<string[]>; get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void>; remove(key: string): Promise<void> };
	rotated: RotatedCredentials;
	mcpClient(): McpSession;
	models(settings: Settings, onReport?: (message: string) => void): Promise<LoadedModels>;
}

const TIMEOUTS = { connectTimeout: 15_000, readTimeout: 60_000 };

export const nativeFetch: McpFetch = async (input, init) => {
	const headers = headerRecord(init?.headers);
	let data: unknown;
	const body = init?.body;
	if (typeof body === "string") {
		data = (headers["content-type"] ?? "").includes("json") ? JSON.parse(body) : body;
	} else if (body instanceof URLSearchParams) {
		data = body.toString();
		headers["content-type"] ??= "application/x-www-form-urlencoded";
	} else if (body != null) {
		throw new Error("unsupported request body");
	}
	if (headers.authorization) refuseCleartextSecret(String(input));
	init?.signal?.throwIfAborted();
	const response = await CapacitorHttp.request({
		url: String(input),
		method: init?.method ?? "GET",
		headers,
		...(data === undefined ? {} : { data }),
		responseType: "text",
		...TIMEOUTS,
	});
	const text = typeof response.data === "string" ? response.data : response.data == null ? "" : JSON.stringify(response.data);
	return new Response(NULL_BODY_STATUS.has(response.status) ? null : text, { status: response.status, headers: response.headers });
};

export function capacitorPlatform(modelIds: Promise<Record<string, string[]>>): Platform {
	return {
		inApp,
		native,
		phone: native.has("BotFiles") ? { folder: (folder, network) => new PhoneEnv(folder, network), removeFolder: removePhoneFolder } : undefined,
		plain: {
			get: (key) => localStorage.getItem(key),
			set: (key, value) => localStorage.setItem(key, value),
			remove: (key) => localStorage.removeItem(key),
		},
		secrets: {
			keys: () => SecureStorage.keys(),
			get: async (key) => {
				if (!(await SecureStorage.keys()).includes(key)) return undefined;
				const stored = await SecureStorage.get(key);
				return typeof stored === "string" ? stored : undefined;
			},
			set: async (key, value) => {
				await SecureStorage.set(key, value);
			},
			remove: async (key) => {
				if ((await SecureStorage.keys()).includes(key)) await SecureStorage.remove(key);
			},
		},
		rotated: { cloudflare: saveCloudflareCredential, azure: saveAzureCredential },
		mcpClient: () => new McpClient({ name: "pi-mobile", version: "1.0.0" }),
		models: (settings, onReport) => loadModels(settings, modelIds, onReport),
	};
}
