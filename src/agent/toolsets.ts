// Toolsets: the groups of tools a bot can be given or denied, each one or more extensions, of two kinds.
//
// - Built-in toolsets are the phone's own abilities. They are on unless a bot turns them off, so one added in a later
//   version starts on: the Harness's default selection holds them, and a bot's agent state (pi.agent) lists in
//   extensions.remove the ones it does not use.
// - Services are the MCP servers the user connected. They are off unless a bot is given one: they reach outside the
//   phone, and every one a bot has adds to each of its requests. They are not in the default selection; a bot's
//   extensions.add lists the ones it has.
//
// When a toolset is on, its tools are either always in the bot's requests or loaded when a task needs them: the
// phone's everyday tools and the bot's folder (sandbox or files) always; development and cloud tools, and every
// service, on demand (with tool_search, from a list of their names in the prompt). Once loaded, tools stay in that conversation. What each costs: docs/tools.md.
//
// Some extensions are always on and not listed: the bot's identity, memory, skills, attachments, and triggers (a schedule's run
// needs triggers' instructions and notify, whatever the bot may otherwise do).
import type { AgentState } from "@earendil-works/pi-durable";

export type ToolsetId = "web" | "weather" | "places" | "device" | "apps" | "control" | "contacts" | "photos" | "calls" | "screen" | "health" | "calendar" | "notifications" | "database" | "speech" | "github" | "gcp" | "cloudflare" | "azure" | "sandbox" | "files" | "codemode";

export type ToolsetKind = "builtin" | "service";

/** Whether its tools are in every request, or loaded with tool_search when a task needs them. */
export type ToolsetLoad = "always" | "on-demand";

export interface Toolset {
	kind: ToolsetKind;
	load: ToolsetLoad;
	/** A ToolsetId, or an MCP server's extension name (mcp-<id>). */
	id: string;
	label: string;
	hint: string;
	/** Extension names, as installed in runtime.ts. */
	extensions: readonly string[];
}

export const TOOLSETS: readonly Toolset[] = [
	{ kind: "builtin", load: "always", id: "web", label: "網路", hint: "搜尋、讀網頁", extensions: ["web"] },
	{ kind: "builtin", load: "always", id: "weather", label: "天氣", hint: "這裡或任何地點的逐小時與 16 天預報", extensions: ["weather"] },
	{ kind: "builtin", load: "always", id: "places", label: "地點", hint: "找附近的店家與服務，或依名稱找分店（OpenStreetMap）", extensions: ["places"] },
	{ kind: "builtin", load: "always", id: "device", label: "手機狀態", hint: "位置、感測器、裝置資訊、交通時間", extensions: ["device"] },
	{ kind: "builtin", load: "always", id: "apps", label: "手機 App", hint: "鬧鐘、計時器、信件與簡訊草稿、地圖、分享", extensions: ["phone_apps"] },
	{ kind: "builtin", load: "always", id: "calendar", label: "日曆", hint: "讀行程；新增前先問你", extensions: ["calendar"] },
	{ kind: "builtin", load: "always", id: "contacts", label: "聯絡人", hint: "用名字找電話、email、生日", extensions: ["contacts"] },
	{ kind: "builtin", load: "always", id: "photos", label: "相片", hint: "依時間、地點、相簿找照片並看內容", extensions: ["photos"] },
	{ kind: "builtin", load: "always", id: "calls", label: "通話與簡訊", hint: "通話紀錄、未接來電、簡訊（驗證碼、銀行通知）", extensions: ["calls_sms"] },
	{ kind: "builtin", load: "always", id: "health", label: "健康", hint: "步數、睡眠、心率、運動、體重（Health Connect）", extensions: ["health"] },
	{ kind: "builtin", load: "always", id: "screen", label: "螢幕使用時間", hint: "每個 app 用了多久、解鎖幾次（設定 › 手機）", extensions: ["screen_time"] },
	{ kind: "builtin", load: "always", id: "control", label: "手機控制", hint: "音樂播放、勿擾模式（需要通知讀取）", extensions: ["phone_control"] },
	{ kind: "builtin", load: "always", id: "notifications", label: "通知", hint: "讀、回覆、清除手機收到的通知：LINE、信件、外送…（設定 › 手機）", extensions: ["notifications"] },
	{ kind: "builtin", load: "always", id: "database", label: "資料庫", hint: "手機上的 SQLite：記帳、清單、紀錄，自己建表查詢（設定 › 資料庫）", extensions: ["database"] },
	{ kind: "builtin", load: "always", id: "speech", label: "語音", hint: "用耳機念出來；關掉後耳機排程只寫文字", extensions: ["speech"] },
	{ kind: "builtin", load: "on-demand", id: "github", label: "GitHub", hint: "查詢直接執行，寫入先問你", extensions: ["github"] },
	{ kind: "builtin", load: "on-demand", id: "gcp", label: "Google Cloud", hint: "從手機呼叫 API，寫入先問你", extensions: ["gcp"] },
	{ kind: "builtin", load: "on-demand", id: "cloudflare", label: "Cloudflare", hint: "從手機呼叫 API，寫入先問你", extensions: ["cloudflare"] },
	{ kind: "builtin", load: "on-demand", id: "azure", label: "Azure", hint: "從手機呼叫 API，寫入先問你", extensions: ["azure"] },
	{ kind: "builtin", load: "always", id: "sandbox", label: "Sandbox", hint: "在遠端電腦上跑指令、讀寫檔案", extensions: ["sandbox", "coding-tools"] },
	// The same tools without a sandbox: only one of the two is available, whichever the app has.
	{ kind: "builtin", load: "always", id: "files", label: "檔案", hint: "這個 Bot 在手機上的資料夾：讀寫檔案、跑 bash 指令", extensions: ["files", "coding-tools"] },
	{ kind: "builtin", load: "always", id: "codemode", label: "程式模式", hint: "用腳本一次呼叫多個工具", extensions: ["codemode"] },
];

export interface ToolsetState extends Toolset {
	/** Connected or set up on this phone; an unavailable toolset is off whatever the bot's choice. */
	available: boolean;
	/** The bot's choice. */
	enabled: boolean;
}

/** The extensions whose tools load on demand. */
export const ON_DEMAND_EXTENSIONS = new Set(TOOLSETS.filter((toolset) => toolset.load === "on-demand").flatMap((toolset) => toolset.extensions));

/** A conversation's edit of the default selection: services it adds and built-ins it removes. */
export type Selection = { add: string[]; remove: string[] };

export function selectionOf(state: AgentState | undefined): Selection {
	const extensions = state?.extensions;
	if (!extensions || Array.isArray(extensions)) return { add: [], remove: [] };
	return { add: extensions.add ?? [], remove: extensions.remove ?? [] };
}

export function isEnabled(selection: Selection, toolset: Toolset): boolean {
	return toolset.kind === "builtin"
		? !toolset.extensions.some((name) => selection.remove.includes(name))
		: toolset.extensions.every((name) => selection.add.includes(name));
}

/** The selection after turning one toolset on or off, keeping the rest of it. */
export function withToolset(selection: Selection, toolset: Toolset, enabled: boolean): Selection {
	const without = (names: readonly string[]) => names.filter((name) => !toolset.extensions.includes(name));
	if (toolset.kind === "builtin") {
		return { add: selection.add, remove: enabled ? without(selection.remove) : [...without(selection.remove), ...toolset.extensions] };
	}
	return { add: enabled ? [...without(selection.add), ...toolset.extensions] : without(selection.add), remove: selection.remove };
}
