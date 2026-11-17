import { type ReactNode, type TouchEvent, useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Source } from "../ui/subscribed.ts";
import { haptic } from "./haptics.ts";
import { isBack, useLast } from "./layers.ts";
import { ownsSidewaysDrag } from "./SidePanel.tsx";
import { intentOf, Motion, positionAfter, type Sample, sampled, type Side, settlesOpen, towardOpen, velocityOf } from "../ui/sideGesture.ts";

type StackPage = { key: string; content: ReactNode; onBack: () => void };

class StackMotion extends Motion {
	#open: boolean | undefined;

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

	follow(open: boolean): void {
		if (open === this.#open) return;
		this.#open = open;
		this.settle(open);
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

export function PageStack({ side, opened, top, children }: { side: Side; opened: Source<boolean>; top: StackPage | undefined; children: ReactNode }) {
	const open = useSyncExternalStore(opened.subscribe, opened.read);
	const topElement = useRef<HTMLDivElement>(null);
	const motion = useRef<StackMotion>(undefined);
	const [mounted, setMounted] = useState(false);
	if (open && !mounted) setMounted(true);
	const shown = useLast(open, top);
	const latest = useRef({ top, opened });
	latest.current = { top, opened };

	const attach = useCallback((base: HTMLDivElement) => {
		const source = latest.current.opened;
		const created = new StackMotion(base, () => topElement.current, (stays) => {
			if (!stays) setMounted(false);
		});
		motion.current = created;
		const follow = () => created.follow(source.read());
		follow();
		return source.subscribe(follow);
	}, []);

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
			latest.current.top?.onBack();
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
					if (intent === "ignore" || !latest.current.top || towardOpen(side, dx) > 0 || ownsSidewaysDrag(event.target, dx)) {
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
			<div ref={attach} className="stack-base" inert={open}>
				{children}
			</div>
			{open || mounted ? (
				<div
					ref={topElement}
					className="stack-top"
					inert={!open}
					data-back={open || undefined}
					onKeyDown={(event) => {
						if (isBack(event)) top?.onBack();
					}}
				>
					{shown?.content}
				</div>
			) : null}
		</div>
	);
}
