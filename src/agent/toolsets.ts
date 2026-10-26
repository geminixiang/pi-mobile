import type { AgentState } from "@earendil-works/pi-durable";
import type { NativePlugin } from "../native.ts";


type ToolsetKind = "builtin" | "service";

export interface Toolset {
	kind: ToolsetKind;
	id: string;
	label: string;
	hint: string;
	extensions: readonly string[];
	needs?: NativePlugin;
}

export const TOOLSETS: readonly Toolset[] = [
	{ kind: "builtin", id: "web", label: "網路", hint: "搜尋、讀網頁", extensions: ["web"] },
	{ kind: "builtin", id: "weather", label: "天氣", hint: "這裡或任何地點的逐小時與 16 天預報", extensions: ["weather"], needs: "Phone" },
	{ kind: "builtin", id: "places", label: "地點", hint: "找附近的店家與服務，或依名稱找分店（OpenStreetMap）", extensions: ["places"], needs: "Phone" },
	{ kind: "builtin", id: "device", label: "手機狀態", hint: "位置、感測器、裝置資訊、交通時間", extensions: ["device"], needs: "Phone" },
	{ kind: "builtin", id: "apps", label: "手機 App", hint: "鬧鐘、計時器、信件與簡訊草稿、地圖、分享", extensions: ["phone_apps"], needs: "Apps" },
	{ kind: "builtin", id: "calendar", label: "日曆", hint: "讀行程、新增活動", extensions: ["calendar"], needs: "Calendar" },
	{ kind: "builtin", id: "contacts", label: "聯絡人", hint: "用名字找電話、email、生日", extensions: ["contacts"], needs: "Contacts" },
	{ kind: "builtin", id: "photos", label: "相片", hint: "依時間、地點、相簿找照片並看內容", extensions: ["photos"], needs: "Photos" },
	{ kind: "builtin", id: "calls", label: "通話與簡訊", hint: "通話紀錄、未接來電、簡訊（驗證碼、銀行通知）", extensions: ["calls_sms"], needs: "Records" },
	{ kind: "builtin", id: "health", label: "健康", hint: "步數、睡眠、心率、運動、體重（Health Connect）", extensions: ["health"], needs: "Health" },
	{ kind: "builtin", id: "screen", label: "螢幕使用時間", hint: "每個 app 用了多久、解鎖幾次（設定 › 手機）", extensions: ["screen_time"], needs: "Usage" },
	{ kind: "builtin", id: "control", label: "手機控制", hint: "鈴聲與音量、螢幕亮度、手電筒、Wi‑Fi 與藍牙、音樂播放、勿擾", extensions: ["phone_control"], needs: "Notifications" },
	{ kind: "builtin", id: "phone_screen", label: "手機畫面", hint: "看手機畫面，替你開 app、點、滑、打字（設定 › 手機）", extensions: ["phone_screen"], needs: "PhoneScreen" },
	{ kind: "builtin", id: "notifications", label: "通知", hint: "讀、回覆、清除手機收到的通知：LINE、信件、外送…（設定 › 手機）", extensions: ["notifications"], needs: "Notifications" },
	{ kind: "builtin", id: "database", label: "資料庫", hint: "手機上的 SQLite：記帳、清單、紀錄，自己建表查詢（設定 › 資料庫）", extensions: ["database"], needs: "Database" },
	{ kind: "builtin", id: "speech", label: "語音", hint: "用耳機念出來；關掉後耳機的自動化只寫文字", extensions: ["speech"], needs: "Voice" },
	{ kind: "builtin", id: "github", label: "GitHub", hint: "用你的 token 呼叫 REST API", extensions: ["github"] },
	{ kind: "builtin", id: "gcp", label: "Google Cloud", hint: "從手機呼叫 API", extensions: ["gcp"] },
	{ kind: "builtin", id: "cloudflare", label: "Cloudflare", hint: "從手機呼叫 API", extensions: ["cloudflare"] },
	{ kind: "builtin", id: "azure", label: "Azure", hint: "從手機呼叫 API", extensions: ["azure"] },
	{ kind: "builtin", id: "computer", label: "電腦畫面", hint: "看電腦的螢幕，用它的滑鼠和鍵盤", extensions: ["computer"] },
	{ kind: "builtin", id: "sandbox", label: "電腦", hint: "在電腦上跑指令、讀寫檔案", extensions: ["sandbox", "coding-tools"] },
	{ kind: "builtin", id: "files", label: "檔案", hint: "這個 Bot 在手機上的資料夾：讀寫檔案、跑 bash 指令", extensions: ["files", "coding-tools"], needs: "BotFiles" },
];

export const usable = (toolset: Toolset, native: ReadonlySet<NativePlugin>): boolean => !toolset.needs || native.has(toolset.needs);

export const TOOL_NEEDS: Readonly<Record<string, NativePlugin>> = { scan_document: "Scanner" };

export function unusableExtensions(native: ReadonlySet<NativePlugin>): ReadonlySet<string> {
	const kept = new Set(TOOLSETS.filter((toolset) => usable(toolset, native)).flatMap((toolset) => toolset.extensions));
	return new Set([
		...(native.has("Triggers") ? [] : ["triggers"]),
		...TOOLSETS.filter((toolset) => !usable(toolset, native))
			.flatMap((toolset) => toolset.extensions)
			.filter((name) => !kept.has(name)),
	]);
}

export interface ToolsetState extends Toolset {
	available: boolean;
	enabled: boolean;
}

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

export function withToolset(selection: Selection, toolset: Toolset, enabled: boolean): Selection {
	const without = (names: readonly string[]) => names.filter((name) => !toolset.extensions.includes(name));
	if (toolset.kind === "builtin") {
		return { add: selection.add, remove: enabled ? without(selection.remove) : [...without(selection.remove), ...toolset.extensions] };
	}
	return { add: enabled ? [...without(selection.add), ...toolset.extensions] : without(selection.add), remove: selection.remove };
}
