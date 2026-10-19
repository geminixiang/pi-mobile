import type { ReactNode } from "react";

/** Bottom sheet over a dimmed backdrop; tapping the backdrop closes it unless `modal`. */
export function Sheet({ children, onClose, title, modal }: { children: ReactNode; onClose?: () => void; title?: string; modal?: boolean }) {
	return (
		<div className="backdrop" onClick={modal ? undefined : onClose}>
			<div className="sheet" role="dialog" aria-label={title} onClick={(event) => event.stopPropagation()}>
				<div className="grabber" />
				{title ? <h2 className="sheet-title">{title}</h2> : null}
				{children}
			</div>
		</div>
	);
}
