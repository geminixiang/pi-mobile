import { createContext, type ReactNode, type RefObject, type TouchEvent, useCallback, useContext, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { haptic } from "./haptics.ts";
import { useBack, useLast } from "./layers.ts";
import { intentOf, Motion, positionAfter, type Range, type Sample, sampled, type Side, settlesOpen, towardOpen, velocityOf } from "../ui/sideGesture.ts";

export type SidePage = { open: boolean; label: string; onBack: () => void; content: ReactNode };

class PanelMotion extends Motion {
	constructor(
		readonly side: Side,
		private readonly viewport: HTMLElement,
		private readonly popup: HTMLElement,
		private readonly card: RefObject<HTMLElement | null>,
		private readonly pageElement: RefObject<HTMLElement | null>,
		readonly page: () => { open: boolean; onBack: () => void },
		settled: () => void,
	) {
		super(settled);
	}

	width(): number {
		return this.popup.offsetWidth;
	}

	protected reveal(shown: boolean): void {
		this.card.current?.toggleAttribute("data-side-shown", shown);
		this.viewport.toggleAttribute("data-open", shown);
	}

	deepest(): number {
		return this.viewport.offsetWidth / Math.max(1, this.width());
	}

	pageRange(): Range {
		return { min: 1, max: this.deepest() };
	}

	pageUnit(): number {
		return this.viewport.offsetWidth / Math.max(0.01, this.deepest() - 1);
	}

	protected render(position: number): void {
		const deep = String(Math.max(0, Math.min(1, (position - 1) / Math.max(0.01, this.deepest() - 1))));
		this.card.current?.style.setProperty(this.side === "left" ? "--side-left" : "--side-right", String(position));
		this.popup.style.setProperty("--side-reveal", String(Math.min(position, 1)));
		this.popup.style.setProperty("--side-deep", deep);
		this.pageElement.current?.style.setProperty("--side-deep", deep);
		this.pageElement.current?.toggleAttribute("data-shown", position > 1);
	}
}

type TouchHandlers = {
	onTouchStart: (event: TouchEvent) => void;
	onTouchMove: (event: TouchEvent) => void;
	onTouchEnd: (event: TouchEvent) => void;
	onTouchCancel: (event: TouchEvent) => void;
};
type Drag = { motion: PanelMotion; from: number; fromX: number; width: number; range: Range | undefined; samples: Sample[] };
type Gesture = { x: number; y: number; at: number; selecting: boolean; ignored: boolean; drag?: Drag };
type SideState = { open: Side | undefined; disabled: boolean; onChange: (open: Side | undefined) => void };

const SideContext = createContext<{ panels: Map<Side, PanelMotion>; card: RefObject<HTMLElement | null> } | null>(null);

export function ownsSidewaysDrag(target: EventTarget | null, dx: number): boolean {
	if (target instanceof Element && target.closest("input, textarea, select, [contenteditable='true'], [data-layer]")) return true;
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
		if (drag.range) {
			const deep = (drag.motion.position() - drag.range.min) / Math.max(0.01, drag.range.max - drag.range.min);
			const stays = !cancelled && settlesOpen(deep, towardOpen(side, velocityOf(drag.samples, at)));
			drag.motion.settleTo(drag.range.max);
			if (cancelled || stays) return;
			haptic("tick");
			drag.motion.page().onBack();
			return;
		}
		const wasOpen = current().open === side;
		const open = cancelled ? wasOpen : settlesOpen(drag.motion.position(), towardOpen(side, velocityOf(drag.samples, at)));
		if (open === wasOpen) {
			drag.motion.settle(open);
			return;
		}
		haptic(open ? "press" : "tick");
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
				const page = motion.page().open;
				gesture.drag = {
					motion,
					from: motion.position(),
					fromX: touch.clientX,
					width: page ? motion.pageUnit() : motion.width(),
					range: page ? motion.pageRange() : undefined,
					samples: [],
				};
			}
			const { drag } = gesture;
			drag.samples = sampled(drag.samples, touch.clientX, event.timeStamp);
			drag.motion.drag(positionAfter(drag.motion.side, drag.from, touch.clientX - drag.fromX, drag.width, drag.range));
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

export function SidePanel({ side, open, page, onClose, label, children }: { side: Side; open: boolean; page?: SidePage; onClose: () => void; label: string; children: ReactNode }) {
	useBack(open, onClose);
	const deep = open && Boolean(page?.open);
	useBack(deep, () => page?.onBack());
	const context = useContext(SideContext);
	const popup = useRef<HTMLDivElement>(null);
	const pageElement = useRef<HTMLDivElement>(null);
	const motion = useRef<PanelMotion>(undefined);
	const focusedBefore = useRef<Element | null>(undefined);
	const [pageMounted, setPageMounted] = useState(false);
	if (deep && !pageMounted) setPageMounted(true);
	const pageContent = useLast(deep, page?.content);
	const latest = useRef({ deep, page });
	latest.current = { deep, page };

	const restoreFocus = () => {
		const previous = focusedBefore.current;
		focusedBefore.current = undefined;
		if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
	};
	const attach = useCallback(
		(element: HTMLDivElement) => {
			const viewport = element.parentElement;
			if (!context || !viewport) return () => undefined;
			popup.current = element;
			motion.current = new PanelMotion(
				side,
				viewport,
				element,
				context.card,
				pageElement,
				() => ({ open: latest.current.deep, onBack: () => latest.current.page?.onBack() }),
				() => {
					if ((motion.current?.position() ?? 0) <= 1 && !latest.current.deep) setPageMounted(false);
				},
			);
			context.panels.set(side, motion.current);
			return () => {
				context.panels.delete(side);
				restoreFocus();
			};
		},
		[context, side],
	);
	const moveFocus = () => {
		if (!open) return restoreFocus();
		if (focusedBefore.current === undefined) focusedBefore.current = document.activeElement;
		(deep ? pageElement.current : popup.current)?.focus({ preventScroll: true });
	};
	const follow = useCallback(() => {
		const current = motion.current;
		if (current && deep) current.settleTo(current.deepest());
		else current?.settle(open);
		moveFocus();
		return () => undefined;
	}, [open, deep]);

	if (!context) return null;
	return createPortal(
		<div ref={follow} className="side-viewport">
			<div
				ref={attach}
				className={`side-popup side-${side}`}
				role="dialog"
				aria-modal="true"
				aria-label={label}
				tabIndex={-1}
				inert={!open || deep}
				onKeyDown={(event) => {
					if (event.key === "Escape") onClose();
				}}
			>
				{children}
			</div>
			{deep || pageMounted ? (
				<div
					ref={pageElement}
					className={`side-page side-page-${side}`}
					role="dialog"
					aria-modal="true"
					aria-label={page?.label}
					tabIndex={-1}
					inert={!deep}
					onKeyDown={(event) => {
						if (event.key === "Escape") page?.onBack();
					}}
				>
					{pageContent}
				</div>
			) : null}
		</div>,
		document.body,
	);
}
