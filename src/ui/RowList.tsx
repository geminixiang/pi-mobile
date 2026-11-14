import type { ReactNode } from "react";

export function RowList({ title, choice, children }: { title?: string; choice?: boolean; children: ReactNode }) {
	return (
		<section className={choice ? "row-list choice-list" : "row-list"}>
			{title ? <h3 className="list-label">{title}</h3> : null}
			{children}
		</section>
	);
}
