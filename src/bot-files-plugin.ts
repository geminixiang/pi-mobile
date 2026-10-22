// BotFilesPlugin on Android (BotFilesPlugin.java): each bot's folder of files in the app's private storage. Paths are
// relative to the bot's folder ("" is the folder); a call rejects with a code (not_found, is_directory, not_directory,
// exists, invalid, http, io) when it fails.
import { registerPlugin } from "@capacitor/core";

export interface BotFileInfo {
	name: string;
	kind: "file" | "directory";
	size: number;
	mtimeMs: number;
}

type At = { bot: string; path: string };

export const BotFiles = registerPlugin<{
	stat(options: At): Promise<BotFileInfo>;
	list(options: At): Promise<{ entries: BotFileInfo[] }>;
	/** Base64 bytes, or UTF-8 text with text: true; the file's whole size alongside. */
	read(options: At & { offset?: number; length?: number; text?: boolean }): Promise<{ size: number; data?: string; text?: string }>;
	/** Replaces the file whole (never half written), or appends. One of text and data (base64). */
	write(options: At & { text?: string; data?: string; append?: boolean }): Promise<void>;
	truncate(options: At & { size: number }): Promise<void>;
	mkdir(options: At & { recursive?: boolean }): Promise<void>;
	remove(options: At & { recursive?: boolean; force?: boolean }): Promise<void>;
	rename(options: { bot: string; from: string; to: string }): Promise<void>;
	removeBot(options: { bot: string }): Promise<void>;
	/** The ids of the bots that have a folder. */
	listBots(): Promise<{ ids: string[] }>;
	/** Download a URL into the folder, streamed to disk; rejects with code "http" on an HTTP error. */
	download(options: At & { url: string }): Promise<{ size: number; contentType: string; url: string }>;
}>("BotFiles");
