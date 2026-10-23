import { Drawer } from "@base-ui/react/drawer";
import { type ReactNode, type TouchEvent, useRef } from "react";
import { useBack } from "./layers.ts";

export type Side = "left" | "right";

const LONG_PRESS_MS = 400;
const TOUCH_SLOP = 10;
const SIDEWAYS_RATIO = 2;

function useSwipeGuard() {
	const press = useRef({ at: 0, x: 0, y: 0, moved: false, selecting: false, sideways: false });
	return {
		onTouchStart: (event: TouchEvent) => {
			const touch = event.touches[0];
			const selected = !(document.getSelection()?.isCollapsed ?? true);
			if (touch) press.current = { at: event.timeStamp, x: touch.clientX, y: touch.clientY, moved: false, selecting: selected, sideways: false };
		},
		onTouchMove: (event: TouchEvent & { preventBaseUIHandler?: () => void }) => {
			const current = press.current;
			const touch = event.touches[0];
			if (!current.moved && touch) {
				const dx = touch.clientX - current.x;
				const dy = touch.clientY - current.y;
				if (Math.hypot(dx, dy) > TOUCH_SLOP) {
					current.moved = true;
					current.selecting ||= event.timeStamp - current.at >= LONG_PRESS_MS;
					current.sideways = Math.abs(dx) > SIDEWAYS_RATIO * Math.abs(dy);
				}
			}
			if (current.selecting || !current.sideways) event.preventBaseUIHandler?.();
		},
	};
}

export function SideSwipe({
	open,
	disabled,
	onChange,
	left,
	right,
	children,
}: {
	open: Side | undefined;
	disabled: boolean;
	onChange: (open: Side | undefined) => void;
	left: ReactNode;
	right: ReactNode;
	children: ReactNode;
}) {
	const guard = useSwipeGuard();
	return (
		<Drawer.Root swipeDirection="left" open={open === "left"} onOpenChange={(next) => onChange(next ? "left" : undefined)}>
			<Drawer.SwipeArea className="side-swipe" disabled={disabled} aria-hidden={false} role={undefined} {...guard}>
				<Drawer.Root swipeDirection="right" open={open === "right"} onOpenChange={(next) => onChange(next ? "right" : undefined)}>
					<Drawer.SwipeArea className="side-swipe" disabled={disabled} aria-hidden={false} role={undefined} {...guard}>
						{children}
					</Drawer.SwipeArea>
					{right}
				</Drawer.Root>
			</Drawer.SwipeArea>
			{left}
		</Drawer.Root>
	);
}

export function SidePanel({ side, open, onClose, label, children }: { side: Side; open: boolean; onClose: () => void; label: string; children: ReactNode }) {
	useBack(open, onClose);
	return (
		<Drawer.Portal keepMounted>
			<Drawer.Backdrop className="side-backdrop" />
			<Drawer.Viewport className="side-viewport">
				<Drawer.Popup className={`side-popup side-${side}`} aria-label={label}>
					{children}
				</Drawer.Popup>
			</Drawer.Viewport>
		</Drawer.Portal>
	);
}
