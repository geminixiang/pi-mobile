import { createContext, type ReactNode, type RefObject, type TouchEvent, useContext, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { useBack } from "./layers.ts";
import { intentOf, Motion, positionAfter, type Sample, sampled, type Side, settlesOpen, towardOpen, velocityOf } from "./sideGesture.ts";

class PanelMotion extends Motion {
	constructor(
		readonly side: Side,
		private readonly viewport: HTMLElement,
		private readonly popup: HTMLElement,
		private readonly card: RefObject<HTMLElement | null>,
	) {
		super();
	}

	width(): number {
		return this.popup.offsetWidth;
	}

	protected reveal(shown: boolean): void {
		this.card.current?.toggleAttribute("data-side-shown", shown);
		this.viewport.toggleAttribute("data-open", shown);
	}

	protected render(position: number): void {
		this.card.current?.style.setProperty(this.side === "left" ? "--side-left" : "--side-right", String(position));
		this.popup.style.setProperty("--side-reveal", String(position));
	}
}

type TouchHandlers = {
	onTouchStart: (event: TouchEvent) => void;
	onTouchMove: (event: TouchEvent) => void;
	onTouchEnd: (event: TouchEvent) => void;
	onTouchCancel: (event: TouchEvent) => void;
};
type Drag = { motion: PanelMotion; from: number; fromX: number; width: number; samples: Sample[] };
type Gesture = { x: number; y: number; at: number; selecting: boolean; ignored: boolean; drag?: Drag };
type SideState = { open: Side | undefined; disabled: boolean; onChange: (open: Side | undefined) => void };

const SideContext = createContext<{ panels: Map<Side, PanelMotion>; card: RefObject<HTMLElement | null> } | null>(null);

function ownsSidewaysDrag(target: EventTarget | null, dx: number): boolean {
	if (target instanceof Element && target.closest("input, textarea, select, [contenteditable='true']")) return true;
	for (let element = target instanceof Element ? target : null; element; element = element.parentElement) {
		const room = element.scrollWidth - element.clientWidth;
		if (room <= 1 || !/auto|scroll/.test(getComputedStyle(element).overflowX)) continue;
		if (dx < 0 ? element.scrollLeft < room - 1 : element.scrollLeft > 0) return true;
	}
	return false;
}

function swipeHandlers(panels: Map<Side, PanelMotion>, current: () => SideState): TouchHandlers {
	let gesture: Gesture | undefined;

	const panelFor = (dx: number): PanelMotion | undefined => {
		const { open, disabled } = current();
		if (open) return towardOpen(open, dx) < 0 ? panels.get(open) : undefined;
		if (disabled) return undefined;
		return panels.get(dx > 0 ? "left" : "right");
	};

	const release = (cancelled: boolean, at: number) => {
		const drag = gesture?.drag;
		gesture = undefined;
		if (!drag) return;
		const { side } = drag.motion;
		const wasOpen = current().open === side;
		const open = cancelled ? wasOpen : settlesOpen(drag.motion.position(), towardOpen(side, velocityOf(drag.samples, at)));
		if (open === wasOpen) {
			drag.motion.settle(open);
			return;
		}
		current().onChange(open ? side : undefined);
	};

	return {
		onTouchStart: (event) => {
			const touch = event.touches[0];
			if (event.touches.length !== 1 || !touch) return release(true, event.timeStamp);
			gesture = { x: touch.clientX, y: touch.clientY, at: event.timeStamp, selecting: !(document.getSelection()?.isCollapsed ?? true), ignored: false };
		},
		onTouchMove: (event) => {
			const touch = event.touches[0];
			if (!gesture || !touch || gesture.ignored) return;
			if (!gesture.drag) {
				const dx = touch.clientX - gesture.x;
				const intent = intentOf({ dx, dy: touch.clientY - gesture.y, elapsedMs: event.timeStamp - gesture.at, selecting: gesture.selecting });
				if (intent === "undecided") return;
				const motion = intent === "swipe" && !ownsSidewaysDrag(event.target, dx) ? panelFor(dx) : undefined;
				if (!motion) {
					gesture.ignored = true;
					return;
				}
				gesture.drag = { motion, from: motion.position(), fromX: touch.clientX, width: motion.width(), samples: [] };
			}
			const { drag } = gesture;
			drag.samples = sampled(drag.samples, touch.clientX, event.timeStamp);
			drag.motion.drag(positionAfter(drag.motion.side, drag.from, touch.clientX - drag.fromX, drag.width));
		},
		onTouchEnd: (event) => release(false, event.timeStamp),
		onTouchCancel: (event) => release(true, event.timeStamp),
	};
}

export function SideSwipe({
	card,
	open,
	disabled,
	onChange,
	left,
	right,
	children,
}: {
	card: RefObject<HTMLElement | null>;
	open: Side | undefined;
	disabled: boolean;
	onChange: (open: Side | undefined) => void;
	left: ReactNode;
	right: ReactNode;
	children: ReactNode;
}) {
	const latest = useRef<SideState>({ open, disabled, onChange });
	latest.current = { open, disabled, onChange };
	const context = useMemo(() => ({ panels: new Map<Side, PanelMotion>(), card }), [card]);
	const handlers = useMemo(() => swipeHandlers(context.panels, () => latest.current), [context]);
	return (
		<SideContext.Provider value={context}>
			<div className="side-swipe" {...handlers}>
				{children}
				{open ? <div className="side-shield" onClick={() => onChange(undefined)} /> : null}
				{left}
				{right}
			</div>
		</SideContext.Provider>
	);
}

export function SidePanel({ side, open, onClose, label, children }: { side: Side; open: boolean; onClose: () => void; label: string; children: ReactNode }) {
	useBack(open, onClose);
	const context = useContext(SideContext);
	const viewport = useRef<HTMLDivElement>(null);
	const popup = useRef<HTMLDivElement>(null);
	const motion = useRef<PanelMotion>(undefined);

	useLayoutEffect(() => {
		if (!context || !viewport.current || !popup.current) return;
		const created = new PanelMotion(side, viewport.current, popup.current, context.card);
		motion.current = created;
		context.panels.set(side, created);
		return () => {
			context.panels.delete(side);
		};
	}, [context, side]);

	useLayoutEffect(() => {
		motion.current?.settle(open);
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const previous = document.activeElement;
		popup.current?.focus({ preventScroll: true });
		return () => {
			if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
		};
	}, [open]);

	if (!context) return null;
	return createPortal(
		<div ref={viewport} className="side-viewport">
			<div
				ref={popup}
				className={`side-popup side-${side}`}
				role="dialog"
				aria-modal="true"
				aria-label={label}
				tabIndex={-1}
				inert={!open}
				onKeyDown={(event) => {
					if (event.key === "Escape") onClose();
				}}
			>
				{children}
			</div>
		</div>,
		document.body,
	);
}
