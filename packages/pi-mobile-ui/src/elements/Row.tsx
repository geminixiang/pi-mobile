import type { ReactNode } from "react";

export function Row({ label, children }: { label: ReactNode; children?: ReactNode }) {
	return (
		<div className="check-row">
			<span className="menu-text">{label}</span>
			{children}
		</div>
	);
}
