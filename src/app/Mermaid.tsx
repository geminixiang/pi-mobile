// A Mermaid diagram drawn as SVG on the phone (beautiful-mermaid: flowcharts, state, sequence, class, ER, and XY
// charts). Loaded on demand (Message.tsx lazy-loads this module), since the layout engine is about 2 MB and most
// answers have no diagram. Inline, so its colors and font are the app's CSS variables and follow the theme.
//
// Measured on the S24 (test/jank.sh, three flings past six diagrams): inline SVG, an SVG <img>, and a PNG drawn once
// all dropped 0 to 2 frames of about 260 per run, as did the same conversation with the diagrams hidden. Inline is the
// simplest of them.
import { renderMermaidSVG } from "beautiful-mermaid";
import { useLayoutEffect, useMemo, useRef } from "react";

/**
 * A diagram wider than the answer is shrunk to fit down to this scale; below it the text would be too small to read,
 * so it keeps its size and scrolls sideways instead.
 */
const MIN_FIT_SCALE = 0.75;

let renders = 0;

/**
 * The renderer's SVG made fit for inline use: no web font import (a network request per diagram, and our fonts are
 * local), the app's sans font, and ids unique per diagram, since every diagram defines the same marker ids and an
 * inline SVG's url(#id) resolves document-wide.
 */
function inline(svg: string): string {
	const prefix = `mm${++renders}-`;
	return svg
		.replace(/@import url\([^)]*\);?/g, "")
		.replace(/text \{ font-family:[^}]*\}/, "text { font-family: var(--sans); }")
		.replace(/\bid="([^"]+)"/g, `id="${prefix}$1"`)
		.replace(/url\(#([^)]+)\)/g, `url(#${prefix}$1)`)
		.replace(/href="#([^"]+)"/g, `href="#${prefix}$1"`);
}

/** The diagram, or undefined when the source does not parse (the caller shows the source instead). */
function render(source: string): string | undefined {
	try {
		// --line, --muted, and --accent are inherited from the app's own variables of those names.
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
