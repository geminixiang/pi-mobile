import { type ReactNode, type TouchEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import { haptic } from "./haptics.ts";
import { useBack, useLast } from "./layers.ts";
import { ownsSidewaysDrag } from "./SidePanel.tsx";
import { intentOf, Motion, positionAfter, type Sample, sampled, type Side, settlesOpen, towardOpen, velocityOf } from "./sideGesture.ts";

type StackPage = { key: string; content: ReactNode; onBack: () => void };

class StackMotion extends Motion {
	constructor(
		private readonly base: HTMLElement,
		private readonly top: () => HTMLElement | null,
		settled: (open: boolean) => void,
	) {
		super(settled);
	}

	width(): number {
		return this.base.offsetWidth;
	}

	protected reveal(): void {}

	protected render(position: number): void {
		this.base.style.setProperty("--stack", String(position));
		this.top()?.style.setProperty("--stack", String(position));
		this.top()?.toggleAttribute("data-shown", position > 0);
	}
}

type Drag = { from: number; fromX: number; width: number; samples: Sample[] };
type Gesture = { x: number; y: number; at: number; ignored: boolean; drag?: Drag };

export function PageStack({ side, top, children }: { side: Side; top: StackPage | undefined; children: ReactNode }) {
	const open = top !== undefined;
	useBack(open, () => top?.onBack());
	const base = useRef<HTMLDivElement>(null);
	const topElement = useRef<HTMLDivElement>(null);
	const motion = useRef<StackMotion>(undefined);
	const [mounted, setMounted] = useState(false);
	const shown = useLast(open, top);
	const latest = useRef(top);
	latest.current = top;

	useLayoutEffect(() => {
		if (!base.current) return;
		motion.current = new StackMotion(base.current, () => topElement.current, (stays) => {
			if (!stays) setMounted(false);
		});
	}, []);

	useLayoutEffect(() => {
		if (open) setMounted(true);
		motion.current?.settle(open);
	}, [open, top?.key]);

	const handlers = useMemo(() => {
		let gesture: Gesture | undefined;
		const release = (cancelled: boolean, at: number) => {
			const drag = gesture?.drag;
			gesture = undefined;
			const current = motion.current;
			if (!drag || !current) return;
			const stays = !cancelled && settlesOpen(current.position(), towardOpen(side, velocityOf(drag.samples, at)));
			current.settle(true);
			if (cancelled || stays) return;
			haptic("tick");
			latest.current?.onBack();
		};
		return {
			onTouchStart: (event: TouchEvent) => {
				const touch = event.touches[0];
				if (event.touches.length !== 1 || !touch) return release(true, event.timeStamp);
				gesture = { x: touch.clientX, y: touch.clientY, at: event.timeStamp, ignored: false };
			},
			onTouchMove: (event: TouchEvent) => {
				const touch = event.touches[0];
				const current = motion.current;
				if (!gesture || !touch || gesture.ignored || !current) return;
				if (!gesture.drag) {
					const dx = touch.clientX - gesture.x;
					const intent = intentOf({ dx, dy: touch.clientY - gesture.y, elapsedMs: event.timeStamp - gesture.at, selecting: !(document.getSelection()?.isCollapsed ?? true) });
					if (intent === "undecided") return;
					if (intent === "ignore" || !latest.current || towardOpen(side, dx) > 0 || ownsSidewaysDrag(event.target, dx)) {
						gesture.ignored = true;
						return;
					}
					gesture.drag = { from: current.position(), fromX: touch.clientX, width: current.width(), samples: [] };
				}
				event.stopPropagation();
				const { drag } = gesture;
				drag.samples = sampled(drag.samples, touch.clientX, event.timeStamp);
				current.drag(positionAfter(side, drag.from, touch.clientX - drag.fromX, drag.width));
			},
			onTouchEnd: (event: TouchEvent) => {
				if (gesture?.drag) event.stopPropagation();
				release(false, event.timeStamp);
			},
			onTouchCancel: (event: TouchEvent) => release(true, event.timeStamp),
		};
	}, [side]);

	return (
		<div className={`page-stack page-stack-${side}`} {...handlers}>
			<div ref={base} className="stack-base" inert={open}>
				{children}
			</div>
			{open || mounted ? (
				<div ref={topElement} className="stack-top" inert={!open}>
					{shown?.content}
				</div>
			) : null}
		</div>
	);
}
