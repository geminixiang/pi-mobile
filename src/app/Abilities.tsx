import { Calendar, FolderOpen, Globe, KeyRound, MessageCircle, Smartphone, Sun, type LucideIcon, Plus } from "lucide-react";
import { useState } from "react";
import type { BuiltinId, ToolsetState } from "../agent/toolsets.ts";
import { ChevronIcon } from "./icons.tsx";
import { Sheet } from "./Sheet.tsx";
import { PlainTiles } from "./PlainTiles.tsx";

type Purpose = { name: string; icon: LucideIcon; ids: readonly BuiltinId[]; services?: true; tryIt: readonly string[] };

const PURPOSES: readonly Purpose[] = [
	{ name: "行程", icon: Calendar, ids: ["calendar"], tryIt: ["這週有哪些行程？", "明天下午三點幫我加個會議"] },
	{ name: "訊息", icon: MessageCircle, ids: ["notifications", "calls_sms", "contacts"], tryIt: ["今天有誰找我？", "有沒有要我處理的通知？"] },
	{ name: "生活", icon: Sun, ids: ["weather", "places", "health", "photos"], tryIt: ["明天要帶傘嗎？", "我這週睡得怎樣？"] },
	{ name: "手機", icon: Smartphone, ids: ["device", "apps", "phone_control", "screen_time", "phone_as_user", "speech"], tryIt: ["十分鐘後提醒我出門", "我今天滑手機多久？"] },
	{ name: "上網", icon: Globe, ids: ["web", "browser", "tw_stocks"], tryIt: ["今天有什麼科技新聞？", "台積電今天收多少？"] },
	{ name: "檔案與電腦", icon: FolderOpen, ids: ["files", "database", "computer_shell", "computer_as_user", "computer_agents"], tryIt: ["你的資料夾裡有什麼？"] },
	{ name: "帳號與服務", icon: KeyRound, ids: ["github", "gcp", "cloudflare", "azure"], services: true, tryIt: [] },
];

const on = (toolset: ToolsetState) => toolset.available && toolset.enabled;

function members(purpose: Purpose, toolsets: readonly ToolsetState[]): ToolsetState[] {
	return toolsets.filter((toolset) => (toolset.kind === "service" ? purpose.services === true : purpose.ids.some((id) => id === toolset.id)));
}

export function Abilities({ toolsets, onToggle, onAsk }: { toolsets: readonly ToolsetState[]; onToggle: (id: string, enabled: boolean) => void; onAsk: (text: string) => void }) {
	const [open, setOpen] = useState<string>();
	const purpose = PURPOSES.find((candidate) => candidate.name === open);
	const shown = PURPOSES.map((candidate) => ({ purpose: candidate, toolsets: members(candidate, toolsets) })).filter((entry) => entry.toolsets.some((toolset) => toolset.available));
	return (
		<>
			<div className="ability-rows">
				{shown.map(({ purpose: each, toolsets: list }) => {
					const usable = list.filter(on);
					const Icon = each.icon;
					return (
						<button type="button" key={each.name} className="ability-row" data-off={usable.length === 0 || undefined} onClick={() => setOpen(each.name)}>
							<span className="place-icon" aria-hidden="true">
								<Icon size={20} strokeWidth={1.6} />
							</span>
							<span className="menu-text">
								{each.name}
								<span className="menu-hint">{usable.length === 0 ? "還沒開" : usable.map((toolset) => toolset.label).join("、")}</span>
							</span>
							{usable.length === 0 ? (
								<span className="ability-add" aria-label="開啟">
									<Plus size={16} strokeWidth={1.8} />
								</span>
							) : (
								<ChevronIcon />
							)}
						</button>
					);
				})}
			</div>
			<Sheet open={purpose !== undefined} title={purpose?.name ?? ""} onClose={() => setOpen(undefined)}>
				{purpose ? <PlainTiles toolsets={members(purpose, toolsets)} onToggle={onToggle} /> : null}
				{purpose && purpose.tryIt.length > 0 && members(purpose, toolsets).some(on) ? (
					<>
						<div className="strip-label">試試看</div>
						<div className="ability-try">
							{purpose.tryIt.map((text) => (
								<button
									type="button"
									key={text}
									onClick={() => {
										setOpen(undefined);
										onAsk(text);
									}}
								>
									↳ {text}
								</button>
							))}
						</div>
					</>
				) : null}
			</Sheet>
		</>
	);
}
