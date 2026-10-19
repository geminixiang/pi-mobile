import { type ReactNode, useRef } from "react";
import { CloseIcon } from "./icons.tsx";
import { useBack, usePresence } from "./layers.ts";

type Kind = "sheet" | "drawer" | "dialog" | "page";

/**
 * Every overlay goes through here, so they share one behavior: enter and exit motion, the back gesture closes the
 * top one, and tapping the backdrop closes it unless `modal`. Children stay rendered from their last open state
 * while the exit animation plays.
 */
export function Layer({
	open,
	kind,
	onClose,
	modal,
	label,
	children,
}: {
	open: boolean;
	kind: Kind;
	onClose: () => void;
	modal?: boolean;
	label?: string;
	children: ReactNode;
}) {
	const { shown, closing } = usePresence(open);
	const last = useRef(children);
	if (open) last.current = children;
	useBack(open && !modal, onClose);
	if (!shown) return null;
	const state = closing ? " closing" : "";
	if (kind === "page") {
		return (
			<div className={`layer-page${state}`} role="dialog" aria-label={label}>
				{last.current}
			</div>
		);
	}
	return (
		<div className={`backdrop ${kind}-backdrop${state}`} onClick={modal ? undefined : onClose}>
			<div className={`layer-${kind}`} role="dialog" aria-label={label} onClick={(event) => event.stopPropagation()}>
				{last.current}
			</div>
		</div>
	);
}

/** Bottom sheet with a labeled header strip. */
export function Sheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
	return (
		<Layer open={open} kind="sheet" onClose={onClose} label={title}>
			<header className="strip">
				<span className="strip-title">{title}</span>
				<button type="button" className="icon-button small" onClick={onClose} aria-label="關閉">
					<CloseIcon />
				</button>
			</header>
			<div className="sheet-body">{children}</div>
		</Layer>
	);
}
