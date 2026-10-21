// Stroke icons drawn on a 24px grid; they inherit currentColor.
import type { ReactNode } from "react";

function Icon({ children, size = 22, width = 1.8 }: { children: ReactNode; size?: number; width?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={width}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{children}
		</svg>
	);
}

export const MenuIcon = () => (
	<Icon>
		<path d="M4 8h16M4 16h10" />
	</Icon>
);
export const ComposeIcon = ({ size = 22 }: { size?: number }) => (
	<Icon size={size}>
		<path d="M11 4.5H7a3 3 0 0 0-3 3v9.5a3 3 0 0 0 3 3h9.5a3 3 0 0 0 3-3V13" />
		<path d="M17.6 3.9a1.9 1.9 0 0 1 2.7 2.7L12.5 14.4l-3.4.8.8-3.4z" />
	</Icon>
);
export const MoreIcon = () => (
	<Icon>
		<circle cx="6" cy="12" r="1.3" fill="currentColor" stroke="none" />
		<circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
		<circle cx="18" cy="12" r="1.3" fill="currentColor" stroke="none" />
	</Icon>
);
export const SendIcon = () => (
	<Icon size={20} width={2.2}>
		<path d="M12 19V5.5M6 11l6-6 6 6" />
	</Icon>
);
export const StopIcon = () => (
	<Icon size={16}>
		<rect x="5" y="5" width="14" height="14" rx="3" fill="currentColor" stroke="none" />
	</Icon>
);
export const PlusIcon = ({ size = 22 }: { size?: number }) => (
	<Icon size={size}>
		<path d="M12 5v14M5 12h14" />
	</Icon>
);
export const ScanIcon = ({ size = 18 }: { size?: number }) => (
	<Icon size={size}>
		<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16M4 12h16" />
	</Icon>
);
export const PaperclipIcon = ({ size = 22 }: { size?: number }) => (
	<Icon size={size}>
		<path d="m20 11.5-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" />
	</Icon>
);
export const ImageIcon = ({ size = 22 }: { size?: number }) => (
	<Icon size={size}>
		<rect x="3.5" y="4.5" width="17" height="15" rx="3.5" />
		<circle cx="9" cy="10" r="1.6" />
		<path d="m4.5 17.5 4.8-4.8 3.7 3.7 2.4-2.4 4.1 4.1" />
	</Icon>
);
export const TrashIcon = ({ size = 18 }: { size?: number }) => (
	<Icon size={size}>
		<path d="M5 7h14M10 7V5h4v2M7 7l.9 11.2A2 2 0 0 0 9.9 20h4.2a2 2 0 0 0 2-1.8L17 7" />
	</Icon>
);
export const GearIcon = ({ size = 20 }: { size?: number }) => (
	<Icon size={size}>
		<path d="M10.3 3.6a1.8 1.8 0 0 1 3.4 0l.3.9a1.8 1.8 0 0 0 2.4 1l.9-.4a1.8 1.8 0 0 1 2.4 2.4l-.4.9a1.8 1.8 0 0 0 1 2.4l.9.3a1.8 1.8 0 0 1 0 3.4l-.9.3a1.8 1.8 0 0 0-1 2.4l.4.9a1.8 1.8 0 0 1-2.4 2.4l-.9-.4a1.8 1.8 0 0 0-2.4 1l-.3.9a1.8 1.8 0 0 1-3.4 0l-.3-.9a1.8 1.8 0 0 0-2.4-1l-.9.4a1.8 1.8 0 0 1-2.4-2.4l.4-.9a1.8 1.8 0 0 0-1-2.4l-.9-.3a1.8 1.8 0 0 1 0-3.4l.9-.3a1.8 1.8 0 0 0 1-2.4l-.4-.9A1.8 1.8 0 0 1 6.7 5.1l.9.4a1.8 1.8 0 0 0 2.4-1z" />
		<circle cx="12" cy="12" r="3" />
	</Icon>
);
/** A note with lines: MEMORY.md. */
export const MemoryIcon = ({ size = 20 }: { size?: number }) => (
	<Icon size={size}>
		<path d="M6 3h9l3 3v15H6z" />
		<path d="M9 10h6M9 14h6M9 18h4" />
	</Icon>
);
export const ArrowDownIcon = ({ size = 13 }: { size?: number }) => (
	<Icon size={size} width={2.4}>
		<path d="M12 5v14M6 13l6 6 6-6" />
	</Icon>
);
export const CloseIcon = ({ size = 18 }: { size?: number }) => (
	<Icon size={size}>
		<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
	</Icon>
);
export const ChevronIcon = ({ open, size = 14 }: { open?: boolean; size?: number }) => (
	<svg
		width={size}
		height={size}
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2.2"
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
		className="chevron"
		style={{ transform: open ? "rotate(90deg)" : undefined }}
	>
		<path d="m9 5 7 7-7 7" />
	</svg>
);
export const ChevronDownIcon = () => (
	<Icon size={14} width={2.2}>
		<path d="m6 9 6 6 6-6" />
	</Icon>
);
export const BackIcon = () => (
	<Icon>
		<path d="M15 5l-7 7 7 7" />
	</Icon>
);
export const SearchIcon = () => (
	<Icon size={18}>
		<circle cx="11" cy="11" r="6.5" />
		<path d="m16 16 4 4" />
	</Icon>
);
export const CheckIcon = ({ size = 14 }: { size?: number }) => (
	<Icon size={size} width={2.6}>
		<path d="m5 12.5 4.5 4.5L19 7.5" />
	</Icon>
);
export const CopyIcon = ({ size = 16 }: { size?: number }) => (
	<Icon size={size}>
		<rect x="8.5" y="8.5" width="11" height="11" rx="2.5" />
		<path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
	</Icon>
);
export const SparkIcon = ({ size = 16 }: { size?: number }) => (
	<Icon size={size}>
		<path d="M12 3.5c.6 4.3 2.2 5.9 6.5 6.5-4.3.6-5.9 2.2-6.5 6.5-.6-4.3-2.2-5.9-6.5-6.5 4.3-.6 5.9-2.2 6.5-6.5z" />
		<path d="M18.5 15.5c.2 1.6.9 2.3 2.5 2.5-1.6.2-2.3.9-2.5 2.5-.2-1.6-.9-2.3-2.5-2.5 1.6-.2 2.3-.9 2.5-2.5z" />
	</Icon>
);
export const TerminalIcon = ({ size = 16 }: { size?: number }) => (
	<Icon size={size}>
		<path d="m5 7 5 5-5 5M12.5 17.5H19" />
	</Icon>
);
export const FileIcon = ({ size = 16 }: { size?: number }) => (
	<Icon size={size}>
		<path d="M13.5 3.5H8a2.5 2.5 0 0 0-2.5 2.5v12A2.5 2.5 0 0 0 8 20.5h8a2.5 2.5 0 0 0 2.5-2.5V8.5z" />
		<path d="M13.5 3.5v5h5M9 13h6M9 16.5h4" />
	</Icon>
);
export const PencilIcon = ({ size = 16 }: { size?: number }) => (
	<Icon size={size}>
		<path d="M15.5 5.5a2.1 2.1 0 0 1 3 3L9 18l-4 1 1-4z" />
	</Icon>
);
export const PhoneIcon = ({ size = 16 }: { size?: number }) => (
	<Icon size={size}>
		<rect x="6.5" y="3" width="11" height="18" rx="2.8" />
		<path d="M10.5 17.5h3" />
	</Icon>
);
export const GitHubIcon = ({ size = 16 }: { size?: number }) => (
	<svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
		<path d="M12 2.5a9.5 9.5 0 0 0-3 18.5c.5.1.7-.2.7-.5v-1.7c-2.6.6-3.2-1.2-3.2-1.2-.4-1.1-1-1.4-1-1.4-.9-.6 0-.6 0-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1 2.8.8.1-.6.3-1 .6-1.3-2.1-.2-4.3-1-4.3-4.7 0-1 .4-1.9 1-2.6-.1-.2-.4-1.2.1-2.6 0 0 .8-.3 2.6 1a9 9 0 0 1 4.8 0c1.8-1.3 2.6-1 2.6-1 .5 1.4.2 2.4.1 2.6.6.7 1 1.5 1 2.6 0 3.7-2.2 4.5-4.3 4.7.3.3.6.9.6 1.8v2.6c0 .3.2.6.7.5A9.5 9.5 0 0 0 12 2.5z" />
	</svg>
);
export const BoxIcon = ({ size = 16 }: { size?: number }) => (
	<Icon size={size}>
		<path d="M12 3 4.5 7v10L12 21l7.5-4V7z" />
		<path d="M4.5 7 12 11l7.5-4M12 11v10" />
	</Icon>
);
export const BranchIcon = ({ size = 18 }: { size?: number }) => (
	<Icon size={size}>
		<circle cx="7" cy="5.5" r="2" />
		<circle cx="7" cy="18.5" r="2" />
		<circle cx="17" cy="8.5" r="2" />
		<path d="M7 7.5v9M17 10.5c0 4-5 3.5-9 6.5" />
	</Icon>
);
export const LayersIcon = ({ size = 18 }: { size?: number }) => (
	<Icon size={size}>
		<path d="m12 4 8.5 4.5L12 13 3.5 8.5z" />
		<path d="m3.5 12.5 8.5 4.5 8.5-4.5M3.5 16.5 12 21l8.5-4.5" />
	</Icon>
);
export const RefreshIcon = ({ size = 18 }: { size?: number }) => (
	<Icon size={size}>
		<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
		<path d="M19.5 4.5v4h-4" />
	</Icon>
);
export const ArrowIcon = () => (
	<Icon size={16}>
		<path d="M5 12h14M13 6l6 6-6 6" />
	</Icon>
);
export const MicIcon = ({ size = 22 }: { size?: number }) => (
	<Icon size={size}>
		<rect x="9" y="3.5" width="6" height="11" rx="3" />
		<path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V20.5" />
	</Icon>
);

/** Brand marks, filled. GitHub, Google Cloud and Cloudflare are from Simple Icons (CC0); Azure is drawn here. */
function Mark({ d, size }: { d: string; size: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<path d={d} />
		</svg>
	);
}
export const GitHubMark = ({ size = 15 }: { size?: number }) => <Mark size={size} d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />;
export const GoogleCloudMark = ({ size = 15 }: { size?: number }) => <Mark size={size} d="M12.19 2.38a9.344 9.344 0 0 0-9.234 6.893c.053-.02-.055.013 0 0-3.875 2.551-3.922 8.11-.247 10.941l.006-.007-.007.03a6.717 6.717 0 0 0 4.077 1.356h5.173l.03.03h5.192c6.687.053 9.376-8.605 3.835-12.35a9.365 9.365 0 0 0-2.821-4.552l-.043.043.006-.05A9.344 9.344 0 0 0 12.19 2.38zm-.358 4.146c1.244-.04 2.518.368 3.486 1.15a5.186 5.186 0 0 1 1.862 4.078v.518c3.53-.07 3.53 5.262 0 5.193h-5.193l-.008.009v-.04H6.785a2.59 2.59 0 0 1-1.067-.23h.001a2.597 2.597 0 1 1 3.437-3.437l3.013-3.012A6.747 6.747 0 0 0 8.11 8.24c.018-.01.04-.026.054-.023a5.186 5.186 0 0 1 3.67-1.69z" />;
export const CloudflareMark = ({ size = 15 }: { size?: number }) => <Mark size={size} d="M16.5088 16.8447c.1475-.5068.0908-.9707-.1553-1.3154-.2246-.3164-.6045-.499-1.0615-.5205l-8.6592-.1123a.1559.1559 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.0278-.084.1123-.1484.2036-.1562l8.7359-.1123c1.0351-.0489 2.1601-.8868 2.5537-1.9136l.499-1.3013c.0215-.0561.0293-.1128.0147-.168-.5625-2.5463-2.835-4.4453-5.5499-4.4453-2.5039 0-4.6284 1.6177-5.3876 3.8614-.4927-.3658-1.1187-.5625-1.794-.499-1.2026.119-2.1665 1.083-2.2861 2.2856-.0283.31-.0069.6128.0635.894C1.5683 13.171 0 14.7754 0 16.752c0 .1748.0142.3515.0352.5273.0141.083.0844.1475.1689.1475h15.9814c.0909 0 .1758-.0645.2032-.1553l.12-.4268zm2.7568-5.5634c-.0771 0-.1611 0-.2383.0112-.0566 0-.1054.0415-.127.0976l-.3378 1.1744c-.1475.5068-.0918.9707.1543 1.3164.2256.3164.6055.498 1.0625.5195l1.8437.1133c.0557 0 .1055.0263.1329.0703.0283.043.0351.1074.0214.1562-.0283.084-.1132.1485-.204.1553l-1.921.1123c-1.041.0488-2.1582.8867-2.5527 1.914l-.1406.3585c-.0283.0713.0215.1416.0986.1416h6.5977c.0771 0 .1474-.0489.169-.126.1122-.4082.1757-.837.1757-1.2803 0-2.6025-2.125-4.727-4.7344-4.727" />;
export const AzureMark = ({ size = 15 }: { size?: number }) => <Mark size={size} d="M9.6 3h4.6L7.3 21H2.5zM15.4 7.2 21.5 21H9.4l6.6-1.8-3.9-4.7z" />;
