import { useEffect, useState } from "react";
import { GlobeIcon } from "../app/icons.tsx";
import { type BrowserState, browserState } from "./tool.ts";

export function BrowserButton({ bot, onOpen }: { bot: string; onOpen: () => void }) {
	const [state, setState] = useState<BrowserState>({ active: new Set(), handovers: [] });
	useEffect(() => browserState.subscribe(setState), []);
	const waiting = state.handovers.some((item) => item.bot === bot);
	const active = state.active.has(bot);
	return (
		<button type="button" className="icon-button browser-button" aria-label="瀏覽器" onClick={onOpen}>
			<GlobeIcon />
			{waiting || active ? <span className="browser-dot" data-active={active || undefined} data-waiting={waiting || undefined} /> : null}
		</button>
	);
}
