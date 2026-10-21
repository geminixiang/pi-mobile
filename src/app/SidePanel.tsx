// A panel from the left (the bot list) or the right (the bot on screen). Its position is one number, p: 0 closed, 1
// open. Opening and closing set it to 1 or 0 and a CSS transition moves it; a drag sets it directly with the
// transition off (sideSwipe.ts). Mounting starts from closed through @starting-style, and unmounting waits for the
// transition. One way of moving, so nothing has to be timed against anything else.
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { useBack } from "./layers.ts";
import type { Side } from "./sideSwipe.ts";

/** Same as the transition in styles.css (.side). */
const MOVE_MS = 220;

export function SidePanel({
	side,
	open,
	drag,
	onClose,
	label,
	children,
}: {
	side: Side;
	open: boolean;
	/** Where the finger holds it, 0 to 1, while this side is dragged. */
	drag: number | undefined;
	onClose: () => void;
	label: string;
	children: ReactNode;
}) {
	const visible = open || drag !== undefined;
	const [mounted, setMounted] = useState(visible);
	useEffect(() => {
		if (visible) {
			setMounted(true);
			return;
		}
		const timer = setTimeout(() => setMounted(false), MOVE_MS);
		return () => clearTimeout(timer);
	}, [visible]);
	useBack(open, onClose);
	// What it showed when last open, while it slides out.
	const last = useRef(children);
	if (visible) last.current = children;
	if (!mounted && !visible) return null;

	const style: CSSProperties & Record<"--p", number> = { "--p": drag ?? (open ? 1 : 0) };
	return (
		<div className={`side side-${side}${drag === undefined ? "" : " dragging"}${visible ? "" : " closing"}`} style={style}>
			<div className="side-scrim" onClick={onClose} />
			<div className="side-sheet" role="dialog" aria-label={label}>
				{last.current}
			</div>
		</div>
	);
}
