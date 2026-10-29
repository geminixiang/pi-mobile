import { PeleError, type RenderResult, render } from "pele";
import { useLayoutEffect, useRef, useState } from "react";

const MIN_FIT_SCALE = 0.75;

let renders = 0;

function draw(source: string, maxWidth: number): RenderResult | undefined {
	try {
		return render(source, {
			idPrefix: `mm${++renders}-`,
			fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--sans"),
			maxWidth,
			padding: 16,
			responsive: false,
			links: false,
			images: false,
		});
	} catch (error) {
		if (error instanceof PeleError) return undefined;
		throw error;
	}
}

export default function Mermaid({ source, fallback }: { source: string; fallback: React.ReactNode }) {
	const [failed, setFailed] = useState(false);
	const box = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const element = box.current;
		if (!element) return;
		const diagram = draw(source, element.clientWidth);
		setFailed(!diagram);
		if (!diagram) return;
		element.innerHTML = diagram.svg;
		const scale = element.clientWidth / diagram.width;
		element.classList.toggle("fit", scale < 1 && scale >= MIN_FIT_SCALE);
	}, [source]);
	if (failed) return fallback;
	return <div className="diagram" ref={box} />;
}
