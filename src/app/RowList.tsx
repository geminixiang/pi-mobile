import type { ReactNode } from "react";

export function RowList({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="row-list">
			<h3 className="list-label">{title}</h3>
			{children}
		</section>
	);
}
