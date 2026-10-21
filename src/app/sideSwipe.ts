// Side panels follow the finger, as in Discord: a horizontal swipe anywhere on the conversation, not only from the
// edge, pulls out the bot list (moving right) or the bot's panel (moving left), and a swipe on an open panel toward
// its edge pushes it back. The edges stay the system's back gesture, as Google's gesture navigation guidance asks;
// the bar's two buttons are the other way in.
//
// While the finger is down this only reports where the panel is (drag); on release it decides open or closed and
// says so with onOpen or onClose. The panel (SidePanel) does all the moving.
import { type TouchEvent as ReactTouchEvent, useRef, useState } from "react";

export type Side = "left" | "right";

/** How far the finger moves before the gesture counts, and how much more sideways than vertical it must be. */
const SLOP = 10;
const SIDEWAYS = 1.5;
/** On release: open when pulled past this share of the panel, or flicked faster than this (px per ms). */
const OPEN_SHARE = 0.4;
const FLICK = 0.45;

/** Where a swipe must not start: the composer (its scroll tab slides the prompt dial), fields, horizontal scrollers. */
function blocked(target: EventTarget | null): boolean {
	if (!(target instanceof Element)) return true;
	if (target.closest(".composer, .dial, input, textarea, select, [contenteditable]")) return true;
	for (let element: Element | null = target; element && !element.classList.contains("app"); element = element.parentElement) {
		const overflow = getComputedStyle(element).overflowX;
		if ((overflow === "auto" || overflow === "scroll") && element.scrollWidth > element.clientWidth + 1) return true;
	}
	return false;
}

/** The panel's width, for turning pixels into a share of it (styles.css .side-sheet). */
function panelWidth(): number {
	return document.querySelector(".side-sheet")?.getBoundingClientRect().width ?? Math.min(window.innerWidth * 0.86, 370);
}

interface Touch {
	x: number;
	y: number;
	/** Set once the movement is clearly sideways. */
	side?: Side;
	/** Whether the panel was open when the touch began. */
	wasOpen: boolean;
	width: number;
	lastX: number;
	lastT: number;
	velocity: number;
}

export function useSideSwipe({
	open,
	disabled,
	onOpen,
	onClose,
}: {
	/** The side panel showing, if any. */
	open: Side | undefined;
	/** Another layer is up (a sheet, a page, a dialog). */
	disabled: boolean;
	onOpen: (side: Side) => void;
	onClose: () => void;
}) {
	const [drag, setDrag] = useState<{ side: Side; progress: number }>();
	const touch = useRef<Touch>(undefined);

	const onTouchStart = (event: ReactTouchEvent) => {
		const point = event.touches[0];
		touch.current = undefined;
		if (!point || event.touches.length > 1 || disabled || (!open && blocked(event.target))) return;
		touch.current = { x: point.clientX, y: point.clientY, wasOpen: open !== undefined, width: 0, lastX: point.clientX, lastT: event.timeStamp, velocity: 0 };
	};

	const onTouchMove = (event: ReactTouchEvent) => {
		const start = touch.current;
		const point = event.touches[0];
		if (!start || !point) return;
		if (!start.side) {
			const dx = point.clientX - start.x;
			const dy = point.clientY - start.y;
			if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
			// Vertical, or an open panel pulled away from its own edge: not ours.
			const side: Side = open ?? (dx > 0 ? "left" : "right");
			const towardEdge = side === "left" ? dx < 0 : dx > 0;
			if (Math.abs(dx) < Math.abs(dy) * SIDEWAYS || (open && !towardEdge)) {
				touch.current = undefined;
				return;
			}
			start.side = side;
			start.width = panelWidth();
			// Measure from here, so the panel does not jump by the slop.
			start.x = point.clientX;
		}
		const moved = (point.clientX - start.x) * (start.side === "left" ? 1 : -1);
		const elapsed = event.timeStamp - start.lastT;
		if (elapsed > 0) start.velocity = ((point.clientX - start.lastX) / elapsed) * (start.side === "left" ? 1 : -1);
		start.lastX = point.clientX;
		start.lastT = event.timeStamp;
		setDrag({ side: start.side, progress: Math.max(0, Math.min(1, (start.wasOpen ? 1 : 0) + moved / start.width)) });
	};

	const onTouchEnd = () => {
		const start = touch.current;
		touch.current = undefined;
		if (!start?.side || !drag) return;
		const keep = start.velocity > FLICK || (start.velocity > -FLICK && drag.progress > (start.wasOpen ? 1 - OPEN_SHARE : OPEN_SHARE));
		if (keep && !start.wasOpen) onOpen(start.side);
		if (!keep && start.wasOpen) onClose();
		setDrag(undefined);
	};

	return { drag, handlers: { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel: onTouchEnd } };
}
