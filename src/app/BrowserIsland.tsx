import { useEffect, useRef, useState } from "react";
import { type BrowserState, browserState, markUsed } from "../agent/tools/browser.ts";
import { native } from "../native.ts";
import { Browser } from "../plugins/browser.ts";
import { messageOf } from "../promise.ts";
import { ChevronIcon } from "./icons.tsx";
import { useBack } from "./layers.ts";

// why: the panel drops in over 260 ms (.island-panel); a native view placed during it lands where the panel is not yet
const DROPPED_MS = 280;
const COLLAPSE_AFTER_MS = 1500;

type Page = { url: string; title: string; loading: boolean };

const hostOf = (url: string) => {
	if (!/^https?:/.test(url)) return "";
	return new URL(url).host.replace(/^www\./, "");
};

function addressOf(typed: string): string {
	const text = typed.trim();
	if (/^https?:\/\//i.test(text)) return text;
	if (!/\s/.test(text) && /\.[a-z]{2,}(\/|$)/i.test(text)) return `https://${text}`;
	return `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
}

function Frame({ bot, onProblem }: { bot: string; onProblem: (text: string) => void }) {
	const frame = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const element = frame.current;
		if (!element) return;
		const place = () => {
			const box = element.getBoundingClientRect();
			Browser.show({ bot, x: box.left, y: box.top, width: box.width, height: box.height, radius: 0 }).catch((error: unknown) => onProblem(messageOf(error)));
		};
		const timer = setTimeout(place, DROPPED_MS);
		const resized = new ResizeObserver(() => setTimeout(place, 0));
		resized.observe(element);
		return () => {
			clearTimeout(timer);
			resized.disconnect();
			Browser.hide({ bot }).catch((error: unknown) => onProblem(messageOf(error)));
		};
	}, [bot, onProblem]);
	return <div ref={frame} className="island-frame" />;
}

function Address({ url, onGo }: { url: string; onGo: (typed: string) => void }) {
	const [draft, setDraft] = useState<string>();
	return (
		<input
			className="island-address"
			value={draft ?? hostOf(url)}
			placeholder="網址或關鍵字"
			enterKeyHint="go"
			inputMode="url"
			autoCapitalize="off"
			autoCorrect="off"
			spellCheck={false}
			onFocus={() => setDraft(url.startsWith("about:") ? "" : url)}
			onBlur={() => setDraft(undefined)}
			onChange={(event) => setDraft(event.target.value)}
			onKeyDown={(event) => {
				if (event.key !== "Enter" || !draft?.trim()) return;
				onGo(draft);
				event.currentTarget.blur();
			}}
		/>
	);
}

export function BrowserIsland({ bot, hidden, working, openKey }: { bot: string | undefined; hidden: boolean; working: boolean; openKey: number }) {
	const [state, setState] = useState<BrowserState>({ used: new Set(), active: new Set(), handovers: [] });
	const [pages, setPages] = useState<Readonly<Record<string, Page>>>({});
	const [expanded, setExpanded] = useState(false);
	const [problem, setProblem] = useState("");
	const auto = useRef(false);
	useEffect(() => browserState.subscribe(setState), []);
	useEffect(() => {
		if (!native.has("Browser")) return;
		const listening = Browser.addListener("page", (page) => setPages((current) => ({ ...current, [page.bot]: page })));
		return () => void listening.then((handle) => handle.remove());
	}, []);

	const active = bot !== undefined && state.active.has(bot);
	const handover = state.handovers.find((item) => item.bot === bot);
	const reason = handover?.reason;
	const page = bot ? pages[bot] : undefined;

	useEffect(() => {
		setExpanded(false);
		setProblem("");
		auto.current = false;
	}, [bot]);
	useEffect(() => {
		if (active) {
			auto.current = true;
			setExpanded(true);
			return;
		}
		if (!auto.current || reason !== undefined || working) return;
		const timer = setTimeout(() => {
			auto.current = false;
			setExpanded(false);
		}, COLLAPSE_AFTER_MS);
		return () => clearTimeout(timer);
	}, [active, reason, working]);
	useEffect(() => {
		if (reason !== undefined) setExpanded(true);
	}, [reason]);
	useEffect(() => {
		if (openKey === 0 || !bot) return;
		auto.current = false;
		markUsed(bot);
		setExpanded(true);
	}, [openKey, bot]);

	const collapse = () => {
		auto.current = false;
		setExpanded(false);
	};
	useBack(expanded && !hidden, collapse);

	if (!bot || !native.has("Browser")) return null;
	const shown = !hidden && (state.used.has(bot) || expanded || handover !== undefined);
	const go = (typed: string) => {
		setProblem("");
		Browser.act({ bot, steps: [{ action: "open", url: addressOf(typed) }], screenshot: false }).catch((error: unknown) => setProblem(messageOf(error)));
	};
	const host = page ? hostOf(page.url) : "";
	return (
		<div className="island" data-expanded={expanded || undefined} hidden={!shown}>
			<button
				type="button"
				className="island-strip"
				aria-label="展開瀏覽器"
				onClick={() => {
					auto.current = false;
					setExpanded(true);
				}}
			>
				<span className="island-dot" data-active={active || page?.loading || undefined} data-waiting={handover ? true : undefined} />
				<span className="island-host">{host || "瀏覽器"}</span>
				<ChevronIcon open />
			</button>
			<div className="island-panel" inert={!expanded}>
				<div className="island-bar">
					<span className="island-dot" data-active={active || page?.loading || undefined} data-waiting={handover ? true : undefined} />
					<Address url={page?.url ?? ""} onGo={go} />
					{handover ? (
						<button type="button" className="btn primary" onClick={() => browserState.handBack(bot)}>
							交還
						</button>
					) : null}
				</div>
				{reason || problem ? <div className="island-note">{problem || reason}</div> : null}
				{expanded && shown ? <Frame bot={bot} onProblem={setProblem} /> : <div className="island-frame" />}
				<button type="button" className="island-grip" aria-label="收起瀏覽器" onClick={collapse} />
			</div>
		</div>
	);
}
