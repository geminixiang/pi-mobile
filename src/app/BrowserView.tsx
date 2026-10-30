import { useEffect, useRef, useState } from "react";
import { Browser } from "../plugins/browser.ts";
import { messageOf } from "../promise.ts";
import { BackButton } from "./BackButton.tsx";
import { Layer } from "./Sheet.tsx";

// why: the page slides in over 260 ms (.layer-page); a native view placed during the slide lands off by up to 28 px
const SETTLED_MS = 280;

function Frame({ bot }: { bot: string }) {
	const frame = useRef<HTMLDivElement>(null);
	const [problem, setProblem] = useState("");
	useEffect(() => {
		const element = frame.current;
		if (!element) return;
		const place = () => {
			const box = element.getBoundingClientRect();
			Browser.show({ bot, x: box.left, y: box.top, width: box.width, height: box.height }).catch((error: unknown) => setProblem(messageOf(error)));
		};
		const timer = setTimeout(place, SETTLED_MS);
		const resized = new ResizeObserver(place);
		resized.observe(element);
		return () => {
			clearTimeout(timer);
			resized.disconnect();
			Browser.hide({ bot }).catch((error: unknown) => setProblem(messageOf(error)));
		};
	}, [bot]);
	return (
		<div ref={frame} className="browser-frame">
			{problem ? <div className="banner error">{problem}</div> : null}
		</div>
	);
}

export function BrowserView({ open, bot, reason, onHandBack, onClose }: { open: boolean; bot: string | undefined; reason: string | undefined; onHandBack: () => void; onClose: () => void }) {
	return (
		<Layer open={open} kind="page" onClose={onClose} label="瀏覽器">
			<div className="screen">
				<header className="bar">
					<BackButton onClick={onClose} />
					<h1 className="bar-heading">瀏覽器</h1>
					{reason !== undefined ? (
						<button type="button" className="btn primary browser-hand-back" onClick={onHandBack}>
							交還
						</button>
					) : (
						<span className="icon-button" aria-hidden="true" />
					)}
				</header>
				{reason ? <div className="banner browser-reason">{reason}</div> : null}
				{open && bot ? <Frame bot={bot} /> : null}
			</div>
		</Layer>
	);
}
