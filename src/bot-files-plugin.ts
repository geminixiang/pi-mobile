import { registerPlugin } from "@capacitor/core";

export interface BotFileInfo {
	name: string;
	kind: "file" | "directory";
	size: number;
	mtimeMs: number;
	executable: boolean;
}

type At = { bot: string; path: string };

export const BotFiles = registerPlugin<{
	stat(options: At): Promise<BotFileInfo>;
	exists(options: At): Promise<{ exists: boolean }>;
	create(options: At & { directory?: boolean }): Promise<void>;
	chmod(options: At & { mode: number }): Promise<void>;
	list(options: At): Promise<{ entries: BotFileInfo[] }>;
	read(options: At & { offset?: number; length?: number; text?: boolean }): Promise<{ size: number; data?: string; text?: string }>;
	write(options: At & { text?: string; data?: string; append?: boolean }): Promise<void>;
	truncate(options: At & { size: number }): Promise<void>;
	mkdir(options: At & { recursive?: boolean }): Promise<void>;
	remove(options: At & { recursive?: boolean; force?: boolean }): Promise<void>;
	rename(options: { bot: string; from: string; to: string }): Promise<void>;
	removeBot(options: { bot: string }): Promise<void>;
	listBots(): Promise<{ ids: string[] }>;
	download(options: At & { url: string }): Promise<{ size: number; contentType: string; url: string }>;
}>("BotFiles");
