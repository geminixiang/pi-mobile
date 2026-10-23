import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { Drawer } from "@base-ui/react/drawer";
import { type ReactNode, useRef } from "react";
import { CloseIcon } from "./icons.tsx";
import { useBack } from "./layers.ts";

function useLast(open: boolean, children: ReactNode): ReactNode {
	const last = useRef(children);
	if (open) last.current = children;
	return last.current;
}

export function Layer({
	open,
	kind,
	onClose,
	label,
	children,
}: {
	open: boolean;
	kind: "page" | "dialog";
	onClose: () => void;
	label?: string;
	children: ReactNode;
}) {
	useBack(open, onClose);
	const content = useLast(open, children);
	return (
		<BaseDialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
			<BaseDialog.Portal>
				{kind === "dialog" ? <BaseDialog.Backdrop className="backdrop" /> : null}
				<BaseDialog.Popup className={`layer-${kind}`} aria-label={label}>
					{content}
				</BaseDialog.Popup>
			</BaseDialog.Portal>
		</BaseDialog.Root>
	);
}

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
