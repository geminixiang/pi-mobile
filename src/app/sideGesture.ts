export type Side = "left" | "right";

export const TOUCH_SLOP = 10;
const SIDEWAYS_RATIO = 2;
const LONG_PRESS_MS = 400;
const FLING_PX_PER_MS = 0.35;
export const SETTLE_MS = 260;
const VELOCITY_WINDOW_MS = 100;

export type Intent = "undecided" | "swipe" | "ignore";

export function intentOf(move: { dx: number; dy: number; elapsedMs: number; selecting: boolean }): Intent {
	if (Math.hypot(move.dx, move.dy) <= TOUCH_SLOP) return "undecided";
	if (move.selecting || move.elapsedMs >= LONG_PRESS_MS) return "ignore";
	return Math.abs(move.dx) > SIDEWAYS_RATIO * Math.abs(move.dy) ? "swipe" : "ignore";
}

export function towardOpen(side: Side, dx: number): number {
	return side === "left" ? dx : -dx;
}

export function positionAfter(side: Side, from: number, dx: number, width: number): number {
	return Math.min(1, Math.max(0, from + towardOpen(side, dx) / width));
}

export function velocityOf(samples: readonly Sample[], releasedAt: number): number {
	const last = samples.at(-1);
	if (!last || releasedAt - last.t > VELOCITY_WINDOW_MS) return 0;
	const first = samples.find((sample) => last.t - sample.t <= VELOCITY_WINDOW_MS) ?? last;
	return last.t === first.t ? 0 : (last.x - first.x) / (last.t - first.t);
}

export type Sample = { x: number; t: number };

export const sampled = (samples: readonly Sample[], x: number, t: number): Sample[] => [...samples.slice(-7), { x, t }];

export function settlesOpen(position: number, velocityTowardOpen: number): boolean {
	if (velocityTowardOpen >= FLING_PX_PER_MS) return true;
	if (velocityTowardOpen <= -FLING_PX_PER_MS) return false;
	return position >= 0.5;
}

export function settleCurve(progress: number): number {
	return 1 - (1 - Math.min(1, Math.max(0, progress))) ** 5;
}

export abstract class Motion {
	#position = 0;
	#frame = 0;
	readonly #settled: ((open: boolean) => void) | undefined;

	constructor(settled?: (open: boolean) => void) {
		this.#settled = settled;
	}

	position(): number {
		return this.#position;
	}

	drag(position: number): void {
		this.#stop();
		this.reveal(true);
		this.#place(position);
	}

	settle(open: boolean): void {
		this.#stop();
		if (open) this.reveal(true);
		const from = this.#position;
		const target = open ? 1 : 0;
		const started = performance.now();
		const step = (now: number) => {
			const progress = from === target ? 1 : (now - started) / SETTLE_MS;
			this.#place(from + (target - from) * settleCurve(progress));
			if (progress < 1) {
				this.#frame = requestAnimationFrame(step);
				return;
			}
			this.#frame = 0;
			if (!open) this.reveal(false);
			this.#settled?.(open);
		};
		step(started);
	}

	protected abstract reveal(shown: boolean): void;

	protected abstract render(position: number): void;

	#stop(): void {
		cancelAnimationFrame(this.#frame);
		this.#frame = 0;
	}

	#place(position: number): void {
		this.#position = position;
		this.render(position);
	}
}
