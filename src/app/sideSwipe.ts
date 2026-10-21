// Side panels follow the finger, as in Discord: a horizontal swipe anywhere on the conversation, not only from the
// edge, pulls out the bot list (to the right) or the bot's panel (to the left), and the same on an open panel pushes
// it back. The edges stay the system's back gesture: Android takes a quick swipe in from either edge, and Google's
// guidance is to leave it that way and keep a button (the bar's two icons) as the other way in.
import { type TouchEvent as ReactTouchEvent, useCallback, useEffect, useRef, useState } from "react";

export type Side = "left" | "right";

/** How far the finger moves before the gesture counts, and how much more sideways than vertical it must be. */
const SLOP = 10;
const SIDEWAYS = 1.5;
/** On release: open when pulled past this share of the panel, or flicked faster than this (px per ms). */
const OPEN_SHARE = 0.4;
const FLICK = 0.45;
/** The settle transition (styles.css .side-settling), and then the panel's exit before the drag style goes. */
const SETTLE_MS = 220;

/** Where a swipe must not start: the composer (its scroll tab slides the prompt dial), fields, horizontal scrollers. */
function blocked(target: EventTarget | null): boolean {
	if (!(target instanceof Element)) return true;
	if (target.closest(".composer, .dial, input, textarea, select, [contenteditable]")) return true;
	for (let element: Element | null = target; element && !element.classList.contains("app"); element = element.parentElement) {
		if (element.scrollWidth > element.clientWidth + 1) {
			const overflow = getComputedStyle(element).overflowX;
			if (overflow === "auto" || overflow === "scroll") return true;
		}
	}
	return false;
}

function panelWidth(side: Side): number {
	const layer = document.querySelector(side === "left" ? ".layer-drawer" : ".layer-panel");
	if (layer) return layer.getBoundingClientRect().width;
	// Not mounted yet: the CSS widths (min(84%, 360px) and min(88%, 380px)).
	return side === "left" ? Math.min(window.innerWidth * 0.84, 360) : Math.min(window.innerWidth * 0.88, 380);
}

export interface SideDrag {
	side: Side;
	/** 0 closed, 1 open. */
	progress: number;
	/** Animating to where it was released, rather than following the finger. */
	settling: boolean;
}

export function useSideSwipe({
	open,
	busy,
	onOpen,
	onClose,
}: {
	/** The side panel showing, if any. */
	open: Side | undefined;
	/** Another layer is up (a sheet, a page, a dialog): no side swipes. */
	busy: boolean;
	onOpen: (side: Side) => void;
	onClose: () => void;
}) {
	const [drag, setDrag] = useState<SideDrag>();
	const touch = useRef<{ x: number; y: number; lastX: number; lastT: number; velocity: number; side?: Side; opening: boolean; width: number }>(undefined);
	const settleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

	// Closed some other way (back, backdrop, an item) while in drag mode: slide out from where it is.
	useEffect(() => {
		if (!drag || touch.current?.side) return;
		if (open !== drag.side && drag.progress !== 0) setDrag({ ...drag, progress: 0, settling: true });
	}, [open, drag]);

	useEffect(() => {
		if (!drag?.settling) return;
		clearTimeout(settleTimer.current);
		// Settled closed: drop the drag style once the layer is gone. Settled open: keep it until the panel closes, since
		// removing it would restart the panel's entry animation.
		if (drag.progress === 0) settleTimer.current = setTimeout(() => setDrag(undefined), SETTLE_MS + 40);
		return () => clearTimeout(settleTimer.current);
	}, [drag]);

	const onTouchStart = useCallback(
		(event: ReactTouchEvent) => {
			const point = event.touches[0];
			touch.current = undefined;
			if (!point || event.touches.length > 1 || busy) return;
			// Opening: only from the conversation. Closing: anywhere on the open panel or its backdrop.
			if (!open && blocked(event.target)) return;
			touch.current = { x: point.clientX, y: point.clientY, lastX: point.clientX, lastT: event.timeStamp, velocity: 0, opening: !open, width: 0 };
		},
		[open, busy],
	);

	const onTouchMove = useCallback(
		(event: ReactTouchEvent) => {
			const start = touch.current;
			const point = event.touches[0];
			if (!start || !point) return;
			const dx = point.clientX - start.x;
			const dy = point.clientY - start.y;
			if (!start.side) {
				if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
				if (Math.abs(dx) < Math.abs(dy) * SIDEWAYS) {
					touch.current = undefined;
					return;
				}
				if (start.opening) {
					start.side = dx > 0 ? "left" : "right";
					onOpen(start.side);
				} else {
					// An open panel is pushed back toward its own edge; the other way does nothing.
					if ((open === "left" && dx > 0) || (open === "right" && dx < 0)) {
						touch.current = undefined;
						return;
					}
					start.side = open;
				}
				start.width = panelWidth(start.side ?? "left");
				// Measure from here, so the panel does not jump by the slop.
				start.x = point.clientX;
			}
			const side = start.side ?? "left";
			const moved = point.clientX - start.x;
			const toward = side === "left" ? moved : -moved;
			const progress = Math.max(0, Math.min(1, (start.opening ? 0 : 1) + toward / start.width));
			const elapsed = event.timeStamp - start.lastT;
			if (elapsed > 0) start.velocity = (point.clientX - start.lastX) / elapsed;
			start.lastX = point.clientX;
			start.lastT = event.timeStamp;
			clearTimeout(settleTimer.current);
			setDrag({ side, progress, settling: false });
		},
		[open, onOpen],
	);

	const onTouchEnd = useCallback(() => {
		const start = touch.current;
		touch.current = undefined;
		if (!start?.side) return;
		const side = start.side;
		setDrag((current) => {
			if (!current) return current;
			// Positive: toward open.
			const flick = side === "left" ? start.velocity : -start.velocity;
			const keep = flick > FLICK || (flick > -FLICK && current.progress > (start.opening ? OPEN_SHARE : 1 - OPEN_SHARE));
			if (!keep) onClose();
			return { side, progress: keep ? 1 : 0, settling: true };
		});
	}, [onClose]);

	return { drag, handlers: { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel: onTouchEnd } };
}
