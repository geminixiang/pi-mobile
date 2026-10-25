import { SecureStorage } from "@aparajita/capacitor-secure-storage";
import { Capacitor, CapacitorHttp } from "@capacitor/core";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { McpClient, type McpFetch } from "@earendil-works/pi-mcp";
import type { Settings } from "../settings.ts";
import { loadModels, type LoadedModels } from "./available-models.ts";
import type { FolderNetwork } from "./files/folder-network.ts";
import { PhoneEnv, removePhoneFolder } from "./files/phone-env.ts";
import { refuseCleartextSecret } from "./cleartext.ts";

export type McpSession = Pick<McpClient, "connect" | "listTools" | "callTool" | "onClose" | "close" | "serverInfo" | "instructions">;

export interface PhoneApp {
	folder(folder: string, network: FolderNetwork): ExecutionEnv;
	removeFolder(folder: string): Promise<void>;
}

export interface Platform {
	phone: PhoneApp | undefined;
	plain: { get(key: string): string | null; set(key: string, value: string): void; remove(key: string): void };
	secrets: { keys(): Promise<string[]>; get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void>; remove(key: string): Promise<void> };
	mcpClient(): McpSession;
	models(settings: Settings, onReport?: (message: string) => void): Promise<LoadedModels>;
}

const TIMEOUTS = { connectTimeout: 15_000, readTimeout: 60_000 };

function headersOf(init: RequestInit | undefined): Record<string, string> {
	const headers: Record<string, string> = {};
	new Headers(init?.headers).forEach((value, key) => {
		headers[key] = value;
	});
	return headers;
}

export const nativeFetch: McpFetch = async (input, init) => {
	const headers = headersOf(init);
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
	if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
	const response = await CapacitorHttp.request({
		url: String(input),
		method: init?.method ?? "GET",
		headers,
		...(data === undefined ? {} : { data }),
		responseType: "text",
		...TIMEOUTS,
	});
	const text = typeof response.data === "string" ? response.data : response.data == null ? "" : JSON.stringify(response.data);
	const nullBody = [101, 204, 205, 304].includes(response.status);
	return new Response(nullBody ? null : text, { status: response.status, headers: response.headers });
};

export function capacitorPlatform(modelIds: Promise<Record<string, string[]>>): Platform {
	return {
		phone: Capacitor.isNativePlatform() ? { folder: (folder, network) => new PhoneEnv(folder, network), removeFolder: removePhoneFolder } : undefined,
		plain: {
			get: (key) => localStorage.getItem(key),
			set: (key, value) => localStorage.setItem(key, value),
			remove: (key) => localStorage.removeItem(key),
		},
		secrets: {
			keys: () => SecureStorage.keys(),
			get: async (key) => {
				const stored = await SecureStorage.get(key);
				return typeof stored === "string" ? stored : undefined;
			},
			set: async (key, value) => {
				await SecureStorage.set(key, value);
			},
			remove: async (key) => {
				await SecureStorage.remove(key);
			},
		},
		mcpClient: () => new McpClient({ name: "pi-mobile", version: "1.0.0" }),
		models: (settings, onReport) => loadModels(settings, modelIds, onReport),
	};
}
