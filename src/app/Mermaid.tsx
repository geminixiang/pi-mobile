import { renderMermaidSVG } from "beautiful-mermaid";
import { useLayoutEffect, useMemo, useRef } from "react";

const MIN_FIT_SCALE = 0.75;

let renders = 0;

function inline(svg: string): string {
	const prefix = `mm${++renders}-`;
	return svg
		.replace(/@import url\([^)]*\);?/g, "")
		.replace(/text \{ font-family:[^}]*\}/, "text { font-family: var(--sans); }")
		.replace(/\bid="([^"]+)"/g, `id="${prefix}$1"`)
		.replace(/url\(#([^)]+)\)/g, `url(#${prefix}$1)`)
		.replace(/href="#([^"]+)"/g, `href="#${prefix}$1"`);
}

function render(source: string): string | undefined {
	try {
		return inline(renderMermaidSVG(source, { bg: "var(--panel)", fg: "var(--text)", transparent: true, padding: 16 }));
	} catch {
		return undefined;
	}
}

export default function Mermaid({ source, fallback }: { source: string; fallback: React.ReactNode }) {
	const svg = useMemo(() => render(source), [source]);
	const box = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const element = box.current?.querySelector("svg");
		const width = Number(element?.getAttribute("width"));
		if (!box.current || !width) return;
		const scale = box.current.clientWidth / width;
		box.current.classList.toggle("fit", scale < 1 && scale >= MIN_FIT_SCALE);
	}, [svg]);
	if (!svg) return fallback;
	return <div className="diagram" ref={box} dangerouslySetInnerHTML={{ __html: svg }} />;
}
