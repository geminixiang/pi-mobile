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
