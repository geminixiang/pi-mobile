import type { AgentState } from "@earendil-works/pi-durable";
import type { Native, NativePlugin } from "../native.ts";

type Where = "phone" | "computer";

export interface BuiltinToolset {
	kind: "builtin";
	id: string;
	label: string;
	hint: string;
	needs?: NativePlugin;
	where?: Where;
}

export interface ServiceToolset {
	kind: "service";
	id: string;
	label: string;
	hint: string;
	extension: string;
}

export type Toolset = BuiltinToolset | ServiceToolset;

const BUILTINS = [
	{ kind: "builtin", id: "web", label: "網路", hint: "搜尋、讀網頁" },
	{ kind: "builtin", id: "weather", label: "天氣", hint: "這裡或任何地點的逐小時與 16 天預報" },
	{ kind: "builtin", id: "tw_stocks", label: "台股", hint: "盤後股價、三大法人、融資融券（證交所、櫃買中心）", needs: "Phone" },
	{ kind: "builtin", id: "places", label: "地點", hint: "找附近的店家與服務，或依名稱找分店（OpenStreetMap）" },
	{ kind: "builtin", id: "device", label: "手機狀態", hint: "位置、感測器、裝置資訊、交通時間" },
	{ kind: "builtin", id: "apps", label: "手機 App", hint: "鬧鐘、計時器、信件與簡訊草稿、地圖、分享" },
	{ kind: "builtin", id: "calendar", label: "日曆", hint: "讀行程、新增活動" },
	{ kind: "builtin", id: "contacts", label: "聯絡人", hint: "用名字找電話、email、生日" },
	{ kind: "builtin", id: "photos", label: "相片", hint: "依時間、地點、相簿找照片並看內容" },
	{ kind: "builtin", id: "calls_sms", label: "通話與簡訊", hint: "通話紀錄、未接來電、簡訊（驗證碼、銀行通知）" },
	{ kind: "builtin", id: "health", label: "健康", hint: "步數、睡眠、心率、運動、體重（Health Connect）" },
	{ kind: "builtin", id: "screen_time", label: "螢幕使用時間", hint: "每個 app 用了多久、解鎖幾次（設定 › 手機）" },
	{ kind: "builtin", id: "phone_control", label: "手機控制", hint: "鈴聲與音量、螢幕亮度、手電筒、Wi‑Fi 與藍牙、音樂播放、勿擾" },
	{ kind: "builtin", id: "browser", label: "瀏覽器", hint: "這個 Bot 自己的瀏覽器：開網頁、點、打字，要登入時交給你", needs: "Browser" },
	{ kind: "builtin", id: "phone_as_user", label: "代你操作 App", hint: "以你的身分看畫面、開 app、點、滑、打字；有些 App 會擋（設定 › 手機）" },
	{ kind: "builtin", id: "notifications", label: "通知", hint: "讀、回覆、清除手機收到的通知：LINE、信件、外送…（設定 › 手機）" },
	{ kind: "builtin", id: "database", label: "資料庫", hint: "手機上的 SQLite：記帳、清單、紀錄，自己建表查詢（設定 › 資料庫）" },
	{ kind: "builtin", id: "speech", label: "語音", hint: "用耳機念出來；關掉後耳機的自動化只寫文字" },
	{ kind: "builtin", id: "github", label: "GitHub", hint: "用你的 token 呼叫 REST API" },
	{ kind: "builtin", id: "gcp", label: "Google Cloud", hint: "從手機呼叫 API" },
	{ kind: "builtin", id: "cloudflare", label: "Cloudflare", hint: "從手機呼叫 API" },
	{ kind: "builtin", id: "azure", label: "Azure", hint: "從手機呼叫 API" },
	{ kind: "builtin", id: "computer_as_user", label: "電腦畫面", hint: "以你的身分看電腦的螢幕，用它的滑鼠和鍵盤", where: "computer" },
	{ kind: "builtin", id: "computer_agents", label: "電腦上的 agent", hint: "交辦工作給電腦上 Herdr 或 Rex 裡的 Claude Code、Codex、pi", where: "computer" },
	{ kind: "builtin", id: "computer_shell", label: "電腦", hint: "在電腦上跑指令、讀寫檔案", where: "computer" },
	{ kind: "builtin", id: "files", label: "檔案", hint: "這個 Bot 在手機上的資料夾：讀寫檔案、跑 bash 指令", needs: "BotFiles", where: "phone" },
] as const satisfies readonly BuiltinToolset[];

export const TOOLSETS: readonly BuiltinToolset[] = BUILTINS;
export type BuiltinId = (typeof BUILTINS)[number]["id"];
export const isBuiltinId = (id: string): id is BuiltinId => TOOLSETS.some((toolset) => toolset.id === id);

export type Groups = readonly [BuiltinId, ...BuiltinId[]] | "always";

export type Place = Where | "missing";

export const isAt = (toolset: BuiltinToolset, place: Place): boolean => toolset.where === undefined || toolset.where === place;

export const usable = (toolset: BuiltinToolset, native: Native): boolean => !toolset.needs || native.has(toolset.needs);

const toolsetOf = (id: BuiltinId): BuiltinToolset => TOOLSETS.find((toolset) => toolset.id === id) ?? brokenGroup(id);

function brokenGroup(id: string): never {
	throw new Error(`${id} is not a toolset in TOOLSETS`);
}

export const usableGroups = (groups: Groups, native: Native): boolean => groups === "always" || groups.some((id) => usable(toolsetOf(id), native));

export function removedTools(owners: ReadonlyMap<string, Groups>, off: readonly string[], place: Place, native: Native): string[] {
	const kept = (groups: Groups) => groups === "always" || groups.some((id) => !off.includes(id) && usable(toolsetOf(id), native) && isAt(toolsetOf(id), place));
	return [...owners].filter(([, groups]) => !kept(groups)).map(([name]) => name);
}

export type ToolsetState = Toolset & { available: boolean; enabled: boolean };

const RENAMED: Partial<Record<BuiltinId, readonly string[]>> = {
	apps: ["phone_apps"],
	phone_as_user: ["phone_screen"],
	computer_as_user: ["computer"],
	computer_shell: ["sandbox", "coding-tools"],
	files: ["coding-tools"],
};

export function legacyOff(extensions: AgentState["extensions"]): BuiltinId[] {
	if (extensions === undefined) return [];
	const off = Array.isArray(extensions)
		? (names: readonly string[]) => names.some((name) => !extensions.includes(name))
		: (names: readonly string[]) => names.some((name) => (extensions.remove ?? []).includes(name));
	return BUILTINS.map((toolset) => toolset.id).filter((id) => off([id, ...(RENAMED[id] ?? [])]));
}
