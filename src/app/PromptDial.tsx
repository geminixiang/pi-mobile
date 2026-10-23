import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { haptic } from "./haptics.ts";
import { ArrowDownIcon } from "./icons.tsx";

export interface DialPrompt {
	id: string;
	text: string;
}

const LONG_PRESS_MS = 380;
const SLOP = 10;
const HYSTERESIS = 0.6;
const PREVIEW_CHARS = 40;
const STEP = 12;
const MIN_STEP = 7;
const MAX_SLOTS = 5;
const REPEAT_DELAY_MS = 350;
const REPEAT_SLOWEST_MS = 180;
const REPEAT_FASTEST_MS = 60;
const EDGE = 24;
const PIVOT_X = 200;
const PIVOT_Y = 60;
const OFFSET = 0.35;
const TRACK = 30;

interface DialState {
	px: number;
	py: number;
	radius: number;
	start: number;
	step: number;
	slots: number;
	slot: number;
	shift: number;
	lineY: number;
}

function angleOf(x: number, y: number, px: number, py: number): number {
	return (Math.atan2(py - y, x - px) * 180) / Math.PI;
}

function sector(dial: DialState, from: number, to: number, inner: number, outer: number): string {
	const a = pointAt(dial, from, outer);
	const b = pointAt(dial, to, outer);
	const c = pointAt(dial, to, inner);
	const d = pointAt(dial, from, inner);
	return `M ${a.x} ${a.y} A ${outer} ${outer} 0 0 1 ${b.x} ${b.y} L ${c.x} ${c.y} A ${inner} ${inner} 0 0 0 ${d.x} ${d.y} Z`;
}

function pointAt(dial: DialState, degrees: number, radius = dial.radius): { x: number; y: number } {
	const radians = (degrees * Math.PI) / 180;
	return { x: dial.px + radius * Math.cos(radians), y: dial.py - radius * Math.sin(radians) };
}

function positionOf(dial: DialState, count: number, slot = dial.slot): number {
	return count - dial.shift - Math.max(0, Math.min(dial.slots - 1, slot));
}

export function ScrollTab({
	hint,
	prompts,
	onScrollToBottom,
	onJump,
}: {
	hint: "latest" | "new" | undefined;
	prompts: DialPrompt[];
	onScrollToBottom: () => void;
	onJump: (id: string | undefined) => void;
}) {
	const [dial, setDial] = useState<DialState>();
	const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | undefined>(undefined);
	const opened = useRef(false);
	const count = prompts.length;

	const repeating = dial?.slot === dial?.slots ? "older" : dial?.slot === -1 ? "newer" : undefined;
	useEffect(() => {
		if (!repeating) return;
		let interval = REPEAT_SLOWEST_MS;
		let timer = setTimeout(function step() {
			setDial((current) => {
				if (!current) return current;
				const shift = repeating === "older" ? current.shift + 1 : current.shift - 1;
				if (shift < 0 || positionOf({ ...current, shift }, count, current.slots - 1) < 0) return current;
				haptic("tick");
				const older = positionOf({ ...current, shift }, count, current.slots - 1);
				if (repeating === "older" && older === 0) return { ...current, shift, slot: current.slots - 1 };
				if (repeating === "newer" && shift === 0) return { ...current, shift, slot: 0 };
				return { ...current, shift };
			});
			interval = Math.max(REPEAT_FASTEST_MS, interval * 0.85);
			timer = setTimeout(step, interval);
		}, REPEAT_DELAY_MS);
		return () => clearTimeout(timer);
	}, [repeating, count]);

	const open = (target: HTMLElement, pointerId: number, x: number, y: number) => {
		opened.current = true;
		target.setPointerCapture(pointerId);
		haptic("press");
		const px = window.innerWidth + PIVOT_X;
		const py = y + PIVOT_Y;
		const radius = Math.hypot(x - px, y - py);
		const start = angleOf(x, y, px, py);
		const edge = (window.innerWidth - EDGE - px) / radius;
		const end = edge <= -1 ? 90 : Math.max(90, (Math.acos(Math.max(-1, Math.min(1, edge))) * 180) / Math.PI);
		const wanted = Math.min(MAX_SLOTS, count + 1);
		const ends = wanted < count + 1 ? 1.5 : 0.5;
		const step = Math.max(MIN_STEP, Math.min(STEP, (start - end) / (wanted - 1 + OFFSET + ends)));
		const fits = Math.floor((start - end) / step - OFFSET - ends) + 1;
		const slots = Math.max(2, Math.min(wanted, fits));
		const lineY = target.closest(".input")?.getBoundingClientRect().top ?? window.innerHeight;
		setDial({ px, py, radius, start, step, slots, slot: 0, shift: 0, lineY });
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
		const turned = (dial.start - angleOf(event.clientX, event.clientY, dial.px, dial.py)) / dial.step - OFFSET;
		const highest = positionOf(dial, count, dial.slots - 1) > 0 ? dial.slots : Math.min(dial.slots - 1, count - dial.shift);
		const lowest = dial.shift > 0 ? -1 : 0;
		let slot = dial.slot;
		while (turned > slot + HYSTERESIS && slot < highest) slot++;
		while (turned < slot - HYSTERESIS && slot > lowest) slot--;
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
	const cell = dial?.step ?? STEP;
	const slotAngle = (slot: number) => (dial ? dial.start - (slot + OFFSET) * cell : 0);
	const beyond = dial ? positionOf(dial, count, dial.slots - 1) : 0;
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
						<defs>
							<clipPath id="dial-above-line">
								<rect x={0} y={0} width="100%" height={dial.lineY} />
							</clipPath>
						</defs>
						{(() => {
							const inner = dial.radius - TRACK;
							const outer = dial.radius + TRACK;
							const cellPath = (slot: number, from = inner, to = outer) =>
								sector(dial, slotAngle(slot) + cell / 2, slotAngle(slot) - cell / 2, from, to);
							const lowest = dial.shift > 0 ? -1 : 0;
							const highest = beyond > 0 ? dial.slots : dial.slots - 1;
							const cells = Array.from({ length: highest - lowest + 1 }, (_, index) => lowest + index);
							const ruler = (
								<>
									<path
										className="dial-track"
										d={sector(dial, slotAngle(lowest) + cell * (lowest < 0 ? 0.5 : 1.5), slotAngle(highest) - cell / 2, inner, outer)}
									/>
									<path className="dial-cell" d={cellPath(dial.slot)} />
									<path className="dial-bar" d={cellPath(dial.slot, outer - 2, outer)} />
									{cells.slice(0, -1).map((slot) =>
										[
											[outer - 6, outer],
											[inner, inner + 6],
										].map(([from, to], edge) => {
											const a = pointAt(dial, slotAngle(slot) - cell / 2, from);
											const b = pointAt(dial, slotAngle(slot) - cell / 2, to);
											return <line key={`${slot}-${edge}`} className="dial-mark" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
										}),
									)}
									{cells.map((slot) => {
										const shows = positionOf(dial, count, slot);
										const label =
											slot === dial.slots ? `+${beyond}` : slot === -1 ? `+${dial.shift}` : shows === count ? "新" : `${shows + 1}`;
										const kind = slot === dial.slots || slot === -1 ? "dial-more" : "dial-number";
										return (
											<text
												key={slot}
												className={`${kind}${slot === dial.slot ? " selected" : ""}`}
												{...pointAt(dial, slotAngle(slot), dial.radius + TRACK / 2)}
											>
												{label}
											</text>
										);
									})}
								</>
							);
							return lowest < 0 ? ruler : <g clipPath="url(#dial-above-line)">{ruler}</g>;
						})()}
					</svg>
				</div>
			) : null}
		</>
	);
}
