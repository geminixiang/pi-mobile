import { TOUCH_SLOP } from "./sideGesture.ts";

const PRESSABLE = "button:not(:disabled), label, a, [role=button]";
const TYPED = "input:not([type=checkbox], [type=radio]), textarea, select, [contenteditable]";
const SHOWN_MS = 120;
const LATE_CLICK_MS = 400;

type Point = { x: number; y: number };
type Pressed = Point & { element: HTMLElement; at: number; held: boolean };

export function staysPut(down: Point, up: Point): boolean {
	return Math.hypot(up.x - down.x, up.y - down.y) <= TOUCH_SLOP;
}

export function showPresses(root: Document): void {
	let pressed: Pressed | undefined;
	let suppliedAt = Number.NEGATIVE_INFINITY;
	const end = (keepMs: number) => {
		if (!pressed) return;
		const { element } = pressed;
		pressed = undefined;
		if (keepMs === 0) {
			element.removeAttribute("data-pressed");
			return;
		}
		setTimeout(() => {
			if (pressed?.element !== element) element.removeAttribute("data-pressed");
		}, keepMs);
	};
	const options = { capture: true, passive: true };
	root.addEventListener(
		"pointerdown",
		(event) => {
			end(0);
			const target = event.target instanceof Element ? event.target : null;
			const element = target && !target.closest(TYPED) ? target.closest(PRESSABLE) : null;
			if (!(element instanceof HTMLElement)) return;
			element.setAttribute("data-pressed", "");
			pressed = { element, x: event.clientX, y: event.clientY, at: event.timeStamp, held: false };
		},
		options,
	);
	root.addEventListener(
		"pointermove",
		(event) => {
			if (pressed && !staysPut(pressed, { x: event.clientX, y: event.clientY })) end(0);
		},
		options,
	);
	root.addEventListener("contextmenu", (event) => {
		if (!pressed) return;
		if (event.defaultPrevented) pressed.held = true;
		else event.preventDefault();
	});
	root.addEventListener(
		"click",
		(event) => {
			if (!event.isTrusted || event.timeStamp - suppliedAt > LATE_CLICK_MS) return;
			event.preventDefault();
			event.stopImmediatePropagation();
		},
		{ capture: true },
	);
	root.addEventListener(
		"pointerup",
		(event) => {
			if (!pressed) return;
			const { element, at, held } = pressed;
			end(Math.max(1, at + SHOWN_MS - event.timeStamp));
			if (held) return;
			suppliedAt = event.timeStamp;
			element.click();
		},
		options,
	);
	root.addEventListener("pointercancel", () => end(0), options);
}
