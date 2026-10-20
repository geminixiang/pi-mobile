// The scroll tab on the composer's line, and the dial a long press on it opens. The dial turns around the thumb's
// base (just off the right edge, for the right hand), so the arc the thumb sweeps is the scale: sliding up it goes
// back to older messages, down to newer ones. The arc holds a fixed number of detents; the selection snaps into the
// next one only past 60% of the way, with a haptic tick, and lands without bouncing. A conversation with more
// messages than detents keeps going while the thumb rests on the arc's last detent at either end, one message per
// tick, faster the longer it rests. Releasing scrolls to the message; a short tap scrolls to the newest, as before.
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
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
/** Degrees per detent, and how many fit on the arc at most. */
const STEP = 12;
const MAX_SLOTS = 7;
/** Resting on an end detent this long starts stepping on; the interval then shrinks to the fastest. */
const REPEAT_DELAY_MS = 350;
const REPEAT_SLOWEST_MS = 180;
const REPEAT_FASTEST_MS = 60;
/** Where the arc stops: this far from the screen's right edge, and at most straight up from the pivot. */
const EDGE = 20;

interface DialState {
	/** The pivot: the thumb's base, off the right edge. */
	px: number;
	py: number;
	radius: number;
	/** The finger's angle around the pivot when the dial opened: slot 0, the newest end of the visible range. */
	start: number;
	/** Detents on the arc. */
	slots: number;
	/** Selected slot: 0 at the bottom, slots - 1 at the top. */
	slot: number;
	/** Messages the arc's range has moved back from the newest end, by resting on its ends. */
	shift: number;
}

/** Angle of a point around the pivot in degrees, counterclockwise from the right, with y up as in math. */
function angleOf(x: number, y: number, px: number, py: number): number {
	return (Math.atan2(py - y, x - px) * 180) / Math.PI;
}

function pointAt(dial: DialState, degrees: number, radius = dial.radius): { x: number; y: number } {
	const radians = (degrees * Math.PI) / 180;
	return { x: dial.px + radius * Math.cos(radians), y: dial.py - radius * Math.sin(radians) };
}

/** The position a slot shows: prompts.length is the newest end, 0 the oldest message. */
function positionOf(dial: DialState, count: number, slot = dial.slot): number {
	return count - dial.shift - slot;
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
	const count = prompts.length;

	// Resting on an end detent with more messages beyond it: step on, faster the longer the thumb rests there.
	const atTop = dial !== undefined && dial.slot === dial.slots - 1 && positionOf(dial, count) > 0;
	const atBottom = dial !== undefined && dial.slot === 0 && dial.shift > 0;
	const repeating = atTop ? "older" : atBottom ? "newer" : undefined;
	useEffect(() => {
		if (!repeating) return;
		let interval = REPEAT_SLOWEST_MS;
		let timer = setTimeout(function step() {
			setDial((current) => {
				if (!current) return current;
				const shift = repeating === "older" ? current.shift + 1 : current.shift - 1;
				const next = { ...current, shift };
				const position = positionOf(next, count);
				if (position < 0 || shift < 0) return current;
				haptic("tick");
				return next;
			});
			interval = Math.max(REPEAT_FASTEST_MS, interval * 0.85);
			timer = setTimeout(step, interval);
		}, REPEAT_DELAY_MS);
		return () => clearTimeout(timer);
	}, [repeating, count]);

	const open = (target: HTMLElement, pointerId: number, x: number, y: number) => {
		opened.current = true;
		try {
			target.setPointerCapture(pointerId);
		} catch {
			// The pointer already went away; the release arrives as pointerup or pointercancel anyway.
		}
		haptic("press");
		// The pivot sits right of the finger and a little below, off screen, where the thumb's base is; the arc rises
		// toward the upper right and stays on screen.
		const px = window.innerWidth + 40;
		const py = y + 70;
		const radius = Math.hypot(x - px, y - py);
		const start = angleOf(x, y, px, py);
		const edge = (window.innerWidth - EDGE - px) / radius;
		const end = edge <= -1 ? 90 : Math.max(90, (Math.acos(Math.max(-1, Math.min(1, edge))) * 180) / Math.PI);
		const slots = Math.max(2, Math.min(MAX_SLOTS, count + 1, Math.floor((start - end) / STEP) + 1));
		setDial({ px, py, radius, start, slots, slot: 0, shift: 0 });
	};

	const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
		if (count === 0) return;
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
		const turned = (dial.start - angleOf(event.clientX, event.clientY, dial.px, dial.py)) / STEP;
		// Slots past the oldest message do not exist.
		const highest = Math.min(dial.slots - 1, count - dial.shift);
		let slot = dial.slot;
		while (turned > slot + HYSTERESIS && slot < highest) slot++;
		while (turned < slot - HYSTERESIS && slot > 0) slot--;
		if (slot !== dial.slot) {
			haptic("tick");
			setDial({ ...dial, slot });
		}
	};

	const finish = () => {
		if (press.current) clearTimeout(press.current.timer);
		press.current = undefined;
		if (!dial) return;
		const position = positionOf(dial, count);
		setDial(undefined);
		if (position !== count) haptic("confirm");
		onJump(position >= count ? undefined : prompts[position]?.id);
	};

	const position = dial ? positionOf(dial, count) : count;
	const current = prompts[position];
	const slotAngle = (slot: number) => (dial ? dial.start - slot * STEP : 0);
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
						<span className="dial-count">{current ? `${position + 1} / ${count}` : "最新"}</span>
						<span className="dial-text">
							{current
								? current.text.length > PREVIEW_CHARS
									? `${current.text.slice(0, PREVIEW_CHARS)}…`
									: current.text
								: "往上滑選擇較早的訊息，放開就捲過去"}
						</span>
					</div>
					<svg className="dial-ring" width="100%" height="100%" aria-hidden="true">
						{(() => {
							const from = pointAt(dial, slotAngle(0) + STEP * 0.6);
							const to = pointAt(dial, slotAngle(dial.slots - 1) - STEP * 0.6);
							return <path className="dial-arc" d={`M ${from.x} ${from.y} A ${dial.radius} ${dial.radius} 0 0 1 ${to.x} ${to.y}`} />;
						})()}
						{Array.from({ length: dial.slots }, (_, slot) => {
							const shows = positionOf(dial, count, slot);
							if (shows < 0) return null;
							// Short ruler marks across the line.
							const outer = pointAt(dial, slotAngle(slot), dial.radius + 6);
							const inner = pointAt(dial, slotAngle(slot), dial.radius - 6);
							return (
								<line
									key={slot}
									x1={inner.x}
									y1={inner.y}
									x2={outer.x}
									y2={outer.y}
									className={`dial-tick${shows === count ? " newest" : ""}`}
								/>
							);
						})}
						{/* More messages beyond either end of the arc: rest on that end to keep going. */}
						{positionOf(dial, count, dial.slots - 1) > 0 ? (
							<text className="dial-more" {...pointAt(dial, slotAngle(dial.slots - 1) - STEP, dial.radius)}>
								⋯
							</text>
						) : null}
						{dial.shift > 0 ? (
							<text className="dial-more" {...pointAt(dial, slotAngle(0) + STEP, dial.radius)}>
								⋯
							</text>
						) : null}
						{dial.shift === 0 ? (
							<text className="dial-label" {...pointAt(dial, slotAngle(0) + 4, dial.radius + 26)}>
								最新
							</text>
						) : null}
					</svg>
					{/* The knob: a tab like the scroll tab, riding the arc at the selected detent, its number upright. */}
					<span className="dial-knob" style={{ left: pointAt(dial, slotAngle(dial.slot)).x, top: pointAt(dial, slotAngle(dial.slot)).y }}>
						{current ? position + 1 : "↓"}
					</span>
				</div>
			) : null}
		</>
	);
}
