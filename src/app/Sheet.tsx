import { Drawer } from "@base-ui/react/drawer";
import type { ReactNode } from "react";
import { CloseIcon } from "./icons.tsx";
import { useBack, useLast } from "./layers.ts";
import { haptic } from "./haptics.ts";

export function Sheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
	useBack(open, onClose);
	const content = useLast(open, children);
	const heading = useLast(open, title);
	return (
		<Drawer.Root
			open={open}
			onOpenChange={(next, details) => {
				if (next) return;
				if (details.reason === "swipe") haptic("tick");
				onClose();
			}}
		>
			<Drawer.Portal>
				<Drawer.Backdrop className="backdrop sheet-backdrop" data-layer />
				<Drawer.Viewport className="sheet-viewport" data-layer>
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
