import type { ReactNode } from "react";
import { Icon } from "pi-mobile-ui/elements";
import type { TriggerSymbol } from "./when.ts";

const TRIGGER_PATHS: Record<TriggerSymbol, ReactNode> = {
	clock: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 7v5l3 1.5" />
		</>
	),
	headphones: <path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3" />,
	bell: (
		<>
			<path d="M10.268 21a2 2 0 0 0 3.464 0" />
			<path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />
		</>
	),
	pin: (
		<>
			<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" />
			<circle cx="12" cy="10" r="3" />
		</>
	),
	wifi: <path d="M12 20h.01M2 8.82a15 15 0 0 1 20 0M5 12.859a10 10 0 0 1 14 0M8.5 16.429a5 5 0 0 1 7 0" />,
	charging: <path d="m11 7-3 5h4l-3 5M14.856 6H16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.935M22 14v-4M5.14 18H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2.936" />,
	battery: (
		<>
			<path d="M22 14v-4M6 14v-4" />
			<rect x="2" y="6" width="16" height="12" rx="2" />
		</>
	),
	unlock: (
		<>
			<rect width="18" height="11" x="3" y="11" rx="2" />
			<path d="M7 11V7a5 5 0 0 1 9.9-1" />
		</>
	),
	image: (
		<>
			<rect width="18" height="18" x="3" y="3" rx="2" />
			<circle cx="9" cy="9" r="2" />
			<path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
		</>
	),
	car: (
		<>
			<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2M9 17h6" />
			<circle cx="7" cy="17" r="2" />
			<circle cx="17" cy="17" r="2" />
		</>
	),
	globe: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 3a13 13 0 0 0 0 18 13 13 0 0 0 0-18M3 12h18" />
		</>
	),
	bluetooth: <path d="m7 7 10 10-5 5V2l5 5L7 17" />,
	walk: (
		<path d="M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5c0 3.11-2 5.66-2 8.68V16a2 2 0 1 1-4 0ZM20 20v-2.38c0-2.12 1.03-3.12 1-5.62-.03-2.72-1.49-6-4.5-6C14.63 6 14 7.8 14 9.5c0 3.11 2 5.66 2 8.68V20a2 2 0 1 0 4 0ZM16 17h4M4 13h4" />
	),
	bike: (
		<>
			<circle cx="18.5" cy="17.5" r="3.5" />
			<circle cx="5.5" cy="17.5" r="3.5" />
			<circle cx="15" cy="5" r="1" />
			<path d="M12 17.5V14l-3-3 4-3 2 3h2" />
		</>
	),
	still: (
		<>
			<circle cx="12" cy="5" r="1" />
			<path d="m9 20 3-6 3 6M6 8l6 2 6-2M12 10v4" />
		</>
	),
};

export const TriggerIcon = ({ symbol, size = 18 }: { symbol: TriggerSymbol; size?: number }) => (
	<Icon size={size} width={1.7}>
		{TRIGGER_PATHS[symbol]}
	</Icon>
);
