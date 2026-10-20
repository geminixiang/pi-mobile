// The scroll tab on the composer's line, and the dial a long press on it opens: a half circle of detents, one per
// message the user sent, plus the newest end. Turning counterclockwise goes back to older messages, clockwise forward,
// with a haptic tick per detent and the message's first words above the dial; releasing scrolls to it. A short tap
// scrolls to the newest, as before.
import { type PointerEvent as ReactPointerEvent, useRef, useState } from "react";
import { haptic } from "./haptics.ts";
import { ArrowDownIcon } from "./icons.tsx";

export interface DialPrompt {
	id: string;
	text: string;
}

const LONG_PRESS_MS = 380;
/** Degrees of turning per detent. */
const STEP = 20;
const RADIUS = 140;
const PREVIEW_CHARS = 40;
/** Movement before the long press fires that means the finger is scrolling instead. */
const SLOP = 10;

interface DialState {
	cx: number;
	cy: number;
	/** Detent the dial opened on: prompts.length is the newest end. */
	base: number;
	/** Counterclockwise degrees turned since it opened. */
	turned: number;
	lastAngle: number | undefined;
	index: number;
}

/** The finger's angle around the dial's center, in degrees, counterclockwise from the right, as in math. */
function angleOf(x: number, y: number, cx: number, cy: number): number {
	return (Math.atan2(cy - y, x - cx) * 180) / Math.PI;
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

	const open = (target: HTMLElement, pointerId: number) => {
		const rect = target.getBoundingClientRect();
		const base = prompts.length;
		opened.current = true;
		target.setPointerCapture(pointerId);
		haptic("press");
		setDial({ cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2, base, turned: 0, lastAngle: undefined, index: base });
	};

	const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
		if (prompts.length === 0) return;
		const target = event.currentTarget;
		const pointerId = event.pointerId;
		opened.current = false;
		press.current = { x: event.clientX, y: event.clientY, timer: setTimeout(() => open(target, pointerId), LONG_PRESS_MS) };
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
		const angle = angleOf(event.clientX, event.clientY, dial.cx, dial.cy);
		// Too close to the center the angle jumps around; wait until the finger is out on the dial.
		if (Math.hypot(event.clientX - dial.cx, event.clientY - dial.cy) < 24) return;
		const delta = dial.lastAngle === undefined ? 0 : ((angle - dial.lastAngle + 540) % 360) - 180;
		const turned = dial.turned + delta;
		const index = Math.max(0, Math.min(prompts.length, dial.base - Math.round(turned / STEP)));
		if (index !== dial.index) haptic("tick");
		setDial({ ...dial, turned, lastAngle: angle, index });
	};

	const finish = () => {
		if (press.current) clearTimeout(press.current.timer);
		press.current = undefined;
		if (!dial) return;
		const index = dial.index;
		setDial(undefined);
		if (index !== dial.base) haptic("confirm");
		onJump(index >= prompts.length ? undefined : prompts[index]?.id);
	};

	const current = dial ? prompts[dial.index] : undefined;
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
				aria-label={hint ? "捲到最新；長按可以轉動選擇訊息" : "長按可以轉動選擇訊息"}
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
					<div className="dial-preview" style={{ left: dial.cx, top: dial.cy - RADIUS - 24 }}>
						<span className="dial-count">{current ? `${dial.index + 1} / ${prompts.length}` : "最新"}</span>
						<span className="dial-text">
							{current ? (current.text.length > PREVIEW_CHARS ? `${current.text.slice(0, PREVIEW_CHARS)}…` : current.text) : "放開回到最下面"}
						</span>
					</div>
					<svg
						className="dial-ring"
						width={RADIUS * 2 + 40}
						height={RADIUS + 30}
						viewBox={`${-RADIUS - 20} ${-RADIUS - 20} ${RADIUS * 2 + 40} ${RADIUS + 30}`}
						style={{ left: dial.cx - RADIUS - 20, top: dial.cy - RADIUS - 20 }}
						aria-hidden="true"
					>
						<path d={`M ${-RADIUS} 0 A ${RADIUS} ${RADIUS} 0 0 1 ${RADIUS} 0`} className="dial-arc" />
						{Array.from({ length: prompts.length + 1 }, (_, position) => {
							// Older messages wait on the right: turning counterclockwise brings them up to the top.
							const degrees = 90 - (dial.base - position) * STEP + dial.turned;
							if (degrees < -2 || degrees > 182) return null;
							const radians = (degrees * Math.PI) / 180;
							const x = Math.cos(radians);
							const y = -Math.sin(radians);
							const selected = position === dial.index;
							const inner = selected ? RADIUS - 18 : RADIUS - 10;
							return (
								<line
									key={position}
									x1={x * inner}
									y1={y * inner}
									x2={x * (RADIUS + 6)}
									y2={y * (RADIUS + 6)}
									className={`dial-tick${selected ? " selected" : ""}${position === prompts.length ? " newest" : ""}`}
								/>
							);
						})}
						<line x1={0} y1={-RADIUS + 26} x2={0} y2={-RADIUS - 14} className="dial-pointer" />
					</svg>
				</div>
			) : null}
		</>
	);
}
