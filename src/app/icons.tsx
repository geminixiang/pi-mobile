// Stroke icons drawn on a 24px grid; they inherit currentColor.
import type { ReactNode } from "react";

function Icon({ children, size = 22 }: { children: ReactNode; size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.8"
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
		<path d="M4 7h16M4 12h10M4 17h16" />
	</Icon>
);
export const ComposeIcon = () => (
	<Icon>
		<path d="M12 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-6" />
		<path d="m17.5 3.5 3 3L12 15l-4 1 1-4z" />
	</Icon>
);
export const MoreIcon = () => (
	<Icon>
		<circle cx="5" cy="12" r="1.2" fill="currentColor" />
		<circle cx="12" cy="12" r="1.2" fill="currentColor" />
		<circle cx="19" cy="12" r="1.2" fill="currentColor" />
	</Icon>
);
export const SendIcon = () => (
	<Icon size={20}>
		<path d="M12 19V5M5 12l7-7 7 7" />
	</Icon>
);
export const StopIcon = () => (
	<Icon size={18}>
		<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
	</Icon>
);
export const ImageIcon = () => (
	<Icon>
		<rect x="3.5" y="4.5" width="17" height="15" rx="3" />
		<circle cx="9" cy="10" r="1.6" />
		<path d="m4 17 5-5 4 4 2.5-2.5L20 18" />
	</Icon>
);
export const TrashIcon = () => (
	<Icon size={18}>
		<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" />
	</Icon>
);
export const GearIcon = () => (
	<Icon size={20}>
		<circle cx="12" cy="12" r="3" />
		<path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" />
	</Icon>
);
export const CloseIcon = () => (
	<Icon size={18}>
		<path d="M6 6l12 12M18 6 6 18" />
	</Icon>
);
export const ChevronIcon = ({ open }: { open?: boolean }) => (
	<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"
		style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform 160ms ease" }}>
		<path d="m9 5 7 7-7 7" />
	</svg>
);
export const BackIcon = () => (
	<Icon>
		<path d="M15 5l-7 7 7 7" />
	</Icon>
);
