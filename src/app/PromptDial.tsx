// The scroll tab on the composer's line, and the dial a long press on it opens. The dial turns around the thumb's
// base (just off the bottom-right corner, for the right hand), so the arc the thumb sweeps is the scale: sliding up
// it goes back to older messages, down to newer ones, with one detent per message the user sent and one for the
// newest end. The detents stay put; the selection snaps into the next one only past 60% of the way, with a haptic
// tick, so it clicks from one to the next instead of drifting. Releasing scrolls to the message. A short tap scrolls
// to the newest, as before.
import { type PointerEvent as ReactPointerEvent, useRef, useState } from "react";
import { haptic } from "./haptics.ts";
import { ArrowDownIcon } from "./icons.tsx";

export interface DialPrompt {
	id: string;
	text: string;
}

const LONG_PRESS_MS = 380;
/** Movement before the long press fires that means the finger is scrolling instead. */
const SLOP = 10;
/** How far past a detent's midpoint the finger must go before the selection moves: no flicker at the boundary. */
const HYSTERESIS = 0.6;
const PREVIEW_CHARS = 40;
/** Detents share the part of the arc that is on screen, within these bounds in degrees. */
const MIN_STEP = 10;
const MAX_STEP = 18;
/** Where the arc stops: this far from the screen's right edge, and at most straight up from the pivot. */
const EDGE = 20;

interface DialState {
	/** The pivot: the thumb's base, just off the bottom-right corner. */
	px: number;
	py: number;
	radius: number;
	/** The finger's angle around the pivot when the dial opened; the newest end sits there. */
	start: number;
	step: number;
	/** Selected detent: prompts.length is the newest end. */
	index: number;
}

/** Angle of a point around the pivot in degrees, counterclockwise from the right, with y up as in math. */
function angleOf(x: number, y: number, px: number, py: number): number {
	return (Math.atan2(py - y, x - px) * 180) / Math.PI;
}

/** A point on the dial at an angle around the pivot. */
function pointAt(dial: DialState, degrees: number, radius = dial.radius): { x: number; y: number } {
	const radians = (degrees * Math.PI) / 180;
	return { x: dial.px + radius * Math.cos(radians), y: dial.py - radius * Math.sin(radians) };
}

export function ScrollTab({
	hint,
	prompts,
	onScrollToBottom,
	onJump,
}: {
	/** Shown when the transcript is scrolled up; without it the tab is an invisible target for the long press. */
	hint: "latest" | "new" | undefined;
	prompts: DialPrompt[];
	onScrollToBottom: () => void;
	onJump: (id: string | undefined) => void;
}) {
	const [dial, setDial] = useState<DialState>();
	const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | undefined>(undefined);
	const opened = useRef(false);

	const open = (target: HTMLElement, pointerId: number, x: number, y: number) => {
		opened.current = true;
		target.setPointerCapture(pointerId);
		haptic("press");
		// The pivot sits right of the finger and a little below, off screen, where the thumb's base is; then the arc rises
		// toward the upper right and most of it stays on screen.
		const px = window.innerWidth + 40;
		const py = y + 70;
		const radius = Math.hypot(x - px, y - py);
		const start = angleOf(x, y, px, py);
		const edge = (window.innerWidth - EDGE - px) / radius;
		const end = edge <= -1 ? 90 : Math.max(90, (Math.acos(Math.max(-1, Math.min(1, edge))) * 180) / Math.PI);
		const step = Math.max(MIN_STEP, Math.min(MAX_STEP, (start - end) / Math.max(1, prompts.length)));
		setDial({ px, py, radius, start, step, index: prompts.length });
	};

	const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
		if (prompts.length === 0) return;
		const target = event.currentTarget;
		const { pointerId, clientX, clientY } = event;
		opened.current = false;
		press.current = { x: clientX, y: clientY, timer: setTimeout(() => open(target, pointerId, clientX, clientY), LONG_PRESS_MS) };
	};

	const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
		if (!dial) {
			const start = press.current;
			if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > SLOP) {
				clearTimeout(start.timer);
				press.current = undefined;
			}
			return;
		}
		// Sliding up the arc turns clockwise around the pivot, toward older messages.
		const turned = dial.start - angleOf(event.clientX, event.clientY, dial.px, dial.py);
		const position = prompts.length - turned / dial.step;
		let index = dial.index;
		while (position < index - HYSTERESIS && index > 0) index--;
		while (position > index + HYSTERESIS && index < prompts.length) index++;
		if (index !== dial.index) {
			haptic("tick");
			setDial({ ...dial, index });
		}
	};

	const finish = () => {
		if (press.current) clearTimeout(press.current.timer);
		press.current = undefined;
		if (!dial) return;
		const index = dial.index;
		setDial(undefined);
		if (index !== prompts.length) haptic("confirm");
		onJump(index >= prompts.length ? undefined : prompts[index]?.id);
	};

	const current = dial ? prompts[dial.index] : undefined;
	const detentAngle = (position: number) => (dial ? dial.start - (prompts.length - position) * dial.step : 0);
	return (
		<>
			<button
				type="button"
				className={`scroll-hint${hint === "new" ? " new" : ""}${hint ? "" : " ghost"}`}
				key={hint ?? "ghost"}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={finish}
				onPointerCancel={finish}
				onContextMenu={(event) => event.preventDefault()}
				onClick={() => {
					// A long press ends in a click too; only a tap scrolls to the newest.
					if (!opened.current && hint) onScrollToBottom();
				}}
				aria-label={hint ? "捲到最新；長按後往上滑可以選擇訊息" : "長按後往上滑可以選擇訊息"}
				tabIndex={hint ? 0 : -1}
			>
				{hint ? (
					<>
						<ArrowDownIcon />
						{hint === "new" ? "有新內容" : "最新"}
					</>
				) : null}
			</button>
			{dial ? (
				<div className="dial" aria-live="polite">
					<div className="dial-preview">
						<span className="dial-count">{current ? `${dial.index + 1} / ${prompts.length}` : "最新"}</span>
						<span className="dial-text">
							{current ? (current.text.length > PREVIEW_CHARS ? `${current.text.slice(0, PREVIEW_CHARS)}…` : current.text) : "往上滑選擇較早的訊息，放開就捲過去"}
						</span>
					</div>
					<svg className="dial-ring" width="100%" height="100%" aria-hidden="true">
						{(() => {
							const from = pointAt(dial, detentAngle(prompts.length) + dial.step * 0.6);
							const to = pointAt(dial, Math.max(detentAngle(0) - dial.step * 0.6, 80));
							return <path className="dial-arc" d={`M ${from.x} ${from.y} A ${dial.radius} ${dial.radius} 0 0 1 ${to.x} ${to.y}`} />;
						})()}
						{Array.from({ length: prompts.length + 1 }, (_, position) => {
							const degrees = detentAngle(position);
							if (degrees < 80) return null;
							const outer = pointAt(dial, degrees, dial.radius + 10);
							const inner = pointAt(dial, degrees, dial.radius - 10);
							return (
								<line
									key={position}
									x1={inner.x}
									y1={inner.y}
									x2={outer.x}
									y2={outer.y}
									className={`dial-tick${position === prompts.length ? " newest" : ""}`}
								/>
							);
						})}
						{/* The knob: rotated around the pivot into the selected detent, snapping with a slight overshoot. */}
						<g
							className="dial-knob"
							style={{
								transformOrigin: `${dial.px}px ${dial.py}px`,
								transform: `rotate(${(prompts.length - dial.index) * dial.step}deg)`,
							}}
						>
							<circle cx={pointAt(dial, dial.start).x} cy={pointAt(dial, dial.start).y} r={13} />
						</g>
					</svg>
				</div>
			) : null}
		</>
	);
}
