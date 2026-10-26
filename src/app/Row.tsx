import type { ReactNode } from "react";

export function Row({ label, hint, children }: { label: ReactNode; hint?: string | undefined; children?: ReactNode }) {
	return (
		<div className="check-row">
			<span className="menu-text">
				{label}
				{hint ? <span className="menu-hint">{hint}</span> : null}
			</span>
			{children}
		</div>
	);
}
