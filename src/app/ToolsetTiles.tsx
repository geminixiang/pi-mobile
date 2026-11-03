import {
	AudioLines,
	Bell,
	Bot,
	Calendar,
	ChartCandlestick,
	CloudSun,
	Compass,
	Contact,
	Database,
	Folder,
	Globe,
	HeartPulse,
	Hourglass,
	Image,
	LayoutGrid,
	MapPin,
	MessageSquareText,
	Monitor,
	Plug,
	Pointer,
	SlidersHorizontal,
	Smartphone,
	SquareTerminal,
	type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { type BuiltinId, isBuiltinId, type ToolsetState } from "../agent/toolsets.ts";
import { AzureMark, CloudflareMark, GitHubMark, GoogleCloudMark } from "./icons.tsx";

type Group = "手機" | "網路與資料" | "帳號" | "電腦";
const GROUPS: readonly Group[] = ["手機", "網路與資料", "帳號", "電腦"];

const line = (Icon: LucideIcon) => <Icon size={22} strokeWidth={1.8} aria-hidden="true" />;
const brand = (mark: ReactNode) => <span className="tool-mark">{mark}</span>;

const LOOK: Record<BuiltinId, { group: Group; icon: ReactNode }> = {
	device: { group: "手機", icon: line(Smartphone) },
	apps: { group: "手機", icon: line(LayoutGrid) },
	calendar: { group: "手機", icon: line(Calendar) },
	contacts: { group: "手機", icon: line(Contact) },
	photos: { group: "手機", icon: line(Image) },
	calls_sms: { group: "手機", icon: line(MessageSquareText) },
	health: { group: "手機", icon: line(HeartPulse) },
	screen_time: { group: "手機", icon: line(Hourglass) },
	phone_control: { group: "手機", icon: line(SlidersHorizontal) },
	notifications: { group: "手機", icon: line(Bell) },
	phone_as_user: { group: "手機", icon: line(Pointer) },
	speech: { group: "手機", icon: line(AudioLines) },
	files: { group: "手機", icon: line(Folder) },
	web: { group: "網路與資料", icon: line(Globe) },
	weather: { group: "網路與資料", icon: line(CloudSun) },
	tw_stocks: { group: "網路與資料", icon: line(ChartCandlestick) },
	places: { group: "網路與資料", icon: line(MapPin) },
	browser: { group: "網路與資料", icon: line(Compass) },
	database: { group: "網路與資料", icon: line(Database) },
	github: { group: "帳號", icon: brand(<GitHubMark />) },
	gcp: { group: "帳號", icon: brand(<GoogleCloudMark />) },
	cloudflare: { group: "帳號", icon: brand(<CloudflareMark />) },
	azure: { group: "帳號", icon: brand(<AzureMark />) },
	computer_shell: { group: "電腦", icon: line(SquareTerminal) },
	computer_as_user: { group: "電腦", icon: line(Monitor) },
	computer_agents: { group: "電腦", icon: line(Bot) },
};

const on = (toolset: ToolsetState) => toolset.available && toolset.enabled;

type Tile = { toolset: ToolsetState; icon: ReactNode };

function Tiles({ title, tiles, onToggle }: { title: string; tiles: Tile[]; onToggle: (id: string, enabled: boolean) => void }) {
	return (
		<section className="tool-group">
			<h3 className="list-label">
				{title}
				<span className="row-count">
					{tiles.filter(({ toolset }) => on(toolset)).length} / {tiles.length}
				</span>
			</h3>
			<div className="tool-tiles">
				{tiles.map(({ toolset, icon }) => (
					<button
						type="button"
						key={toolset.id}
						className="tool-tile"
						aria-pressed={on(toolset)}
						disabled={!toolset.available}
						onClick={() => onToggle(toolset.id, !toolset.enabled)}
					>
						{icon}
						<span className="tool-name">{toolset.label}</span>
						{toolset.available ? null : <span className="tool-note">未設定</span>}
					</button>
				))}
			</div>
		</section>
	);
}

export function ToolsetTiles({ toolsets, onToggle }: { toolsets: ToolsetState[]; onToggle: (id: string, enabled: boolean) => void }) {
	const builtins = toolsets.flatMap((toolset) => (toolset.kind === "builtin" && isBuiltinId(toolset.id) ? [{ toolset, ...LOOK[toolset.id] }] : []));
	const services = toolsets.filter((toolset) => toolset.kind === "service").map((toolset) => ({ toolset, icon: line(Plug) }));
	return (
		<>
			{GROUPS.map((group) => {
				const tiles = builtins.filter((tile) => tile.group === group);
				return tiles.length === 0 ? null : <Tiles key={group} title={group} tiles={tiles} onToggle={onToggle} />;
			})}
			{services.length === 0 ? null : <Tiles title="連接的服務" tiles={services} onToggle={onToggle} />}
		</>
	);
}
