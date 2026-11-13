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

const line = (Icon: LucideIcon) => <Icon size={22} strokeWidth={1.8} aria-hidden="true" />;
const brand = (mark: ReactNode) => <span className="tool-mark">{mark}</span>;

const ICON: Record<BuiltinId, ReactNode> = {
	device: line(Smartphone),
	apps: line(LayoutGrid),
	calendar: line(Calendar),
	contacts: line(Contact),
	photos: line(Image),
	calls_sms: line(MessageSquareText),
	health: line(HeartPulse),
	screen_time: line(Hourglass),
	phone_control: line(SlidersHorizontal),
	notifications: line(Bell),
	phone_as_user: line(Pointer),
	speech: line(AudioLines),
	files: line(Folder),
	web: line(Globe),
	weather: line(CloudSun),
	tw_stocks: line(ChartCandlestick),
	places: line(MapPin),
	browser: line(Compass),
	database: line(Database),
	github: brand(<GitHubMark />),
	gcp: brand(<GoogleCloudMark />),
	cloudflare: brand(<CloudflareMark />),
	azure: brand(<AzureMark />),
	computer_shell: line(SquareTerminal),
	computer_as_user: line(Monitor),
	computer_agents: line(Bot),
};

const on = (toolset: ToolsetState) => toolset.available && toolset.enabled;

type Tile = { toolset: ToolsetState; icon: ReactNode };

function Tiles({ title, tiles, onToggle }: { title?: string; tiles: Tile[]; onToggle: (id: string, enabled: boolean) => void }) {
	return (
		<section className="tool-group">
			{title === undefined ? null : (
			<h3 className="list-label">
				{title}
				<span className="row-count">
					{tiles.filter(({ toolset }) => on(toolset)).length} / {tiles.length}
				</span>
			</h3>
			)}
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

export function PlainTiles({ toolsets, onToggle }: { toolsets: readonly ToolsetState[]; onToggle: (id: string, enabled: boolean) => void }) {
	const tiles = toolsets.map((toolset) => ({ toolset, icon: toolset.kind === "builtin" && isBuiltinId(toolset.id) ? ICON[toolset.id] : line(Plug) }));
	return <Tiles tiles={tiles} onToggle={onToggle} />;
}
