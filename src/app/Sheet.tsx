// Every overlay is a Base UI part, so they share its behavior: focus moves in and back, the page behind cannot be
// scrolled or tapped, and entry and exit are CSS transitions on [data-starting-style] and [data-ending-style]
// (styles.css, Layers). Android's back closes the top one through the app's layer stack (layers.ts), unless `modal`.
//
// Sheets are Drawers from the bottom, so they also close with a swipe down. Side panels are SidePanel.tsx.
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { Drawer } from "@base-ui/react/drawer";
import { type ReactNode, useRef } from "react";
import { CloseIcon } from "./icons.tsx";
import { useBack } from "./layers.ts";

/** What was shown when last open, so content does not vanish while the exit plays (callers often pass null then). */
function useLast(open: boolean, children: ReactNode): ReactNode {
	const last = useRef(children);
	if (open) last.current = children;
	return last.current;
}

/** A full-screen page (settings, memory, workspace) or a centered dialog. */
export function Layer({
	open,
	kind,
	onClose,
	modal,
	label,
	children,
}: {
	open: boolean;
	kind: "page" | "dialog";
	onClose: () => void;
	/** Neither back nor a tap outside closes it; it needs an explicit answer. */
	modal?: boolean;
	label?: string;
	children: ReactNode;
}) {
	// A modal dialog absorbs back: back must not close what is under it either.
	useBack(open, modal ? () => undefined : onClose);
	const content = useLast(open, children);
	return (
		<BaseDialog.Root open={open} onOpenChange={(next) => !next && !modal && onClose()} disablePointerDismissal={modal ?? false}>
			<BaseDialog.Portal>
				{kind === "dialog" ? <BaseDialog.Backdrop className="backdrop" /> : null}
				<BaseDialog.Popup className={`layer-${kind}`} aria-label={label}>
					{content}
				</BaseDialog.Popup>
			</BaseDialog.Portal>
		</BaseDialog.Root>
	);
}

/** Bottom sheet with a labeled header strip; a swipe down closes it. */
export function Sheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
	useBack(open, onClose);
	const content = useLast(open, children);
	const heading = useLast(open, title);
	return (
		<Drawer.Root open={open} onOpenChange={(next) => !next && onClose()}>
			<Drawer.Portal>
				<Drawer.Backdrop className="backdrop sheet-backdrop" />
				<Drawer.Viewport className="sheet-viewport">
					<Drawer.Popup className="layer-sheet" aria-label={title}>
						<header className="strip">
							<span className="strip-title">{heading}</span>
							<button type="button" className="icon-button small" onClick={onClose} aria-label="關閉">
								<CloseIcon />
							</button>
						</header>
						<div className="sheet-body">{content}</div>
					</Drawer.Popup>
				</Drawer.Viewport>
			</Drawer.Portal>
		</Drawer.Root>
	);
}
