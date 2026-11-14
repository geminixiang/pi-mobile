import type { PhonePermissions } from "../interaction/permissions.ts";
import { phonePermissions } from "../interaction/phone-permissions.ts";
import { inForeground } from "../keepAlive.ts";
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
import { Browser } from "../browser/plugin.ts";
import { Triggers } from "../triggers/plugin.ts";
import { headerRecord, NULL_BODY_STATUS } from "./http.ts";
import { parseJson } from "../parse.ts";
import { listenForRedirect } from "./oauth.ts";

export type McpSession = Pick<McpClient, "connect" | "listTools" | "callTool" | "onClose" | "close" | "serverInfo" | "instructions">;

export interface PhoneApp {
	folder(folder: string, network: FolderNetwork): ExecutionEnv;
	removeFolder(folder: string): Promise<void>;
}

interface BotBrowser {
	forget(bot: string): Promise<void>;
}

interface BotReports {
	forget(conversation: string): Promise<void>;
}

export type RotatedCredentials = { cloudflare(json: string): Promise<void>; azure(json: string): Promise<void> };

export interface Platform {
	inApp: boolean;
	native: Native;
	phone: PhoneApp | undefined;
	browser: BotBrowser | undefined;
	reports: BotReports | undefined;
	plain: { get(key: string): string | null; set(key: string, value: string): void; remove(key: string): void };
	secrets: { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void>; remove(key: string): Promise<void> };
	rotated: RotatedCredentials;
	mcpClient(): McpSession;
	mcpFetch: McpFetch;
	loopback: typeof listenForRedirect;
	permissions: PhonePermissions;
	inFront(): Promise<boolean>;
	models(settings: Settings, compactAt: () => number, onReport?: (message: string) => void): Promise<LoadedModels>;
}

const TIMEOUTS = { connectTimeout: 15_000, readTimeout: 60_000 };

const nativeFetch: McpFetch = async (input, init) => {
	const headers = headerRecord(init?.headers);
	let data: unknown;
	const body = init?.body;
	if (typeof body === "string") {
		data = (headers["content-type"] ?? "").includes("json") ? parseJson(body, "MCP 請求") : body;
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
		browser: native.implements(Browser.forget) ? { forget: (bot) => Browser.forget({ bot }) } : undefined,
		reports: native.implements(Triggers.seen) ? { forget: (conversation) => Triggers.seen({ conversation }) } : undefined,
		plain: {
			get: (key) => localStorage.getItem(key),
			set: (key, value) => localStorage.setItem(key, value),
			remove: (key) => localStorage.removeItem(key),
		},
		secrets: {
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
		mcpFetch: nativeFetch,
		loopback: listenForRedirect,
		permissions: phonePermissions,
		inFront: inForeground,
		models: (settings, compactAt, onReport) => loadModels(settings, compactAt, modelIds, onReport),
	};
}
