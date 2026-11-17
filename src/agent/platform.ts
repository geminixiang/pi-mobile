import type { PhonePermissions } from "./permissions.ts";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { McpClient, McpFetch } from "@earendil-works/pi-mcp";
import type { Settings, SettingsStore } from "../settings.ts";
import type { LoadedModels } from "./available-models.ts";
import type { FolderNetwork } from "./files/folder-network.ts";
import type { Native } from "../native.ts";
import type { listenForRedirect } from "./oauth.ts";

export type McpSession = Pick<McpClient, "connect" | "listTools" | "callTool" | "onClose" | "close" | "serverInfo" | "instructions">;

export interface PhoneApp {
	folder(folder: string, network: FolderNetwork): ExecutionEnv;
	removeFolder(folder: string): Promise<void>;
}

export type InstalledApp = { package: string; label: string; version: string };

export interface PhoneApps {
	installed(): Promise<readonly InstalledApp[]>;
}

interface BotBrowser {
	forget(bot: string): Promise<void>;
}

interface BotReports {
	forget(conversation: string): Promise<void>;
}

export interface Platform {
	inApp: boolean;
	native: Native;
	phone: PhoneApp | undefined;
	browser: BotBrowser | undefined;
	reports: BotReports | undefined;
	apps: PhoneApps | undefined;
	plain: { get(key: string): string | null; set(key: string, value: string): void; remove(key: string): void };
	secrets: { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void>; remove(key: string): Promise<void> };
	settings: SettingsStore;
	mcpClient(): McpSession;
	mcpFetch: McpFetch;
	loopback: typeof listenForRedirect;
	permissions: PhonePermissions;
	inFront(): Promise<boolean>;
	models(settings: Settings, compactAt: () => number, onReport?: (message: string) => void): Promise<LoadedModels>;
}
