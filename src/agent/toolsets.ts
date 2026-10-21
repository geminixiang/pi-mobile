// Toolsets: the groups of tools a bot can be given or denied, each one or more extensions. A bot's choice is stored in
// its conversation's agent state (pi.agent) as the extensions it does not select, so a toolset added in a later
// version starts on for every bot. Some extensions are always on and not listed: the bot's identity, memory, skills,
// and triggers (a schedule's run needs triggers' instructions and notify, whatever the bot may otherwise do).
import type { AgentState } from "@earendil-works/pi-durable";

export type ToolsetId = "web" | "device" | "apps" | "calendar" | "notifications" | "speech" | "github" | "gcp" | "cloudflare" | "azure" | "sandbox" | "codemode";

export interface Toolset {
	id: ToolsetId;
	label: string;
	hint: string;
	/** Extension names, as installed in runtime.ts. */
	extensions: readonly string[];
}

export const TOOLSETS: readonly Toolset[] = [
	{ id: "web", label: "網路", hint: "搜尋、讀網頁", extensions: ["web"] },
	{ id: "device", label: "手機狀態", hint: "位置、感測器、裝置資訊、交通時間", extensions: ["device"] },
	{ id: "apps", label: "手機 App", hint: "鬧鐘、計時器、信件與簡訊草稿、地圖、分享", extensions: ["phone_apps"] },
	{ id: "calendar", label: "日曆", hint: "讀行程；新增前先問你", extensions: ["calendar"] },
	{ id: "notifications", label: "通知", hint: "讀手機收到的通知：LINE、信件、外送…（設定 › 通知讀取）", extensions: ["notifications"] },
	{ id: "speech", label: "語音", hint: "用耳機念出來；關掉後耳機排程只寫文字", extensions: ["speech"] },
	{ id: "github", label: "GitHub", hint: "查詢直接執行，寫入先問你", extensions: ["github"] },
	{ id: "gcp", label: "Google Cloud", hint: "從手機呼叫 API，寫入先問你", extensions: ["gcp"] },
	{ id: "cloudflare", label: "Cloudflare", hint: "從手機呼叫 API，寫入先問你", extensions: ["cloudflare"] },
	{ id: "azure", label: "Azure", hint: "從手機呼叫 API，寫入先問你", extensions: ["azure"] },
	{ id: "sandbox", label: "Sandbox", hint: "在遠端電腦上跑指令、讀寫檔案", extensions: ["sandbox", "coding-tools"] },
	{ id: "codemode", label: "程式模式", hint: "用腳本一次呼叫多個工具", extensions: ["codemode"] },
];

export interface ToolsetState extends Toolset {
	/** Connected or set up on this phone; an unavailable toolset is off whatever the bot's choice. */
	available: boolean;
	/** The bot's choice. */
	enabled: boolean;
}

/** The extensions a conversation leaves out, from its stored agent state. */
export function removedExtensions(state: AgentState | undefined): string[] {
	const extensions = state?.extensions;
	if (!extensions || Array.isArray(extensions)) return [];
	return extensions.remove ?? [];
}

/** The removal list after turning one toolset on or off, keeping removals that are not toolsets'. */
export function withToolset(removed: readonly string[], toolset: Toolset, enabled: boolean): string[] {
	const rest = removed.filter((name) => !toolset.extensions.includes(name));
	return enabled ? rest : [...rest, ...toolset.extensions];
}
