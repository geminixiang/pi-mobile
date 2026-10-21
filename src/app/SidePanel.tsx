// The two side panels, on Base UI's Drawer: the bot list from the left, the bot on screen from the right. Base UI
// does the gestures (a swipe on the conversation opens one, following the finger; a swipe on an open one pushes it
// back), focus, and scroll locking; this file only places the parts and styles them (styles.css .side-*).
//
// SideSwipe wraps the conversation: a horizontal swipe anywhere on it, as in Discord, not only from the edge, which
// stays Android's back gesture. Base UI ignores swipes that start on buttons, fields, or horizontal scrollers.
import { Drawer } from "@base-ui/react/drawer";
import type { ReactNode } from "react";
import { useBack } from "./layers.ts";

export type Side = "left" | "right";

/**
 * Each side's Drawer.Root, and the area that opens it, around `children`; each area binds to its nearest root. An
 * area stays enabled while its panel is open: Base UI opens the panel on the swipe's first move, and disabling the
 * area then would cut the swipe short and leave the panel open. The open panel's backdrop covers the areas anyway.
 * The areas hold the conversation, so they must not be aria-hidden as Base UI makes an (empty) swipe area by default.
 */
export function SideSwipe({
	open,
	disabled,
	onChange,
	left,
	right,
	children,
}: {
	open: Side | undefined;
	/** Another layer is up: no swipes. */
	disabled: boolean;
	onChange: (open: Side | undefined) => void;
	/** The panels (SidePanel), rendered inside their roots. */
	left: ReactNode;
	right: ReactNode;
	children: ReactNode;
}) {
	return (
		<Drawer.Root swipeDirection="left" open={open === "left"} onOpenChange={(next) => onChange(next ? "left" : undefined)}>
			<Drawer.SwipeArea className="side-swipe" disabled={disabled} aria-hidden={false} role={undefined}>
				<Drawer.Root swipeDirection="right" open={open === "right"} onOpenChange={(next) => onChange(next ? "right" : undefined)}>
					<Drawer.SwipeArea className="side-swipe" disabled={disabled} aria-hidden={false} role={undefined}>
						{children}
					</Drawer.SwipeArea>
					{right}
				</Drawer.Root>
			</Drawer.SwipeArea>
			{left}
		</Drawer.Root>
	);
}

/** A panel's parts; goes in SideSwipe's `left` or `right`. */
export function SidePanel({ side, open, onClose, label, children }: { side: Side; open: boolean; onClose: () => void; label: string; children: ReactNode }) {
	// Android's back button goes through the app's layer stack, not the browser's close watcher.
	useBack(open, onClose);
	return (
		<Drawer.Portal>
			<Drawer.Backdrop className="side-backdrop" />
			<Drawer.Viewport className="side-viewport">
				<Drawer.Popup className={`side-popup side-${side}`} aria-label={label}>
					{children}
				</Drawer.Popup>
			</Drawer.Viewport>
		</Drawer.Portal>
	);
}
