import { memo, type RefObject, type TouchEvent, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { type BrowserState, browserState } from "../agent/tools/browser.ts";
import { native } from "../native.ts";
import { Browser, type BrowserTabs, MAX_TABS } from "../plugins/browser.ts";
import { messageOf } from "../promise.ts";
import { SEARCH_ENGINES, type SearchEngine } from "../settings.ts";
import { SHEET_START, sheetAfter } from "./browserSheetState.ts";
import { BackIcon, CloseIcon, PlusIcon, RefreshIcon } from "./icons.tsx";
import { useBack } from "./layers.ts";
import { intentOf, Motion, type Sample, sampled, settlesOpen, TOUCH_SLOP, velocityOf } from "./sideGesture.ts";

const COLLAPSE_AFTER_MS = 1500;
// why: --card-radius; the page reaches the sheet's bottom edge, so its corners are cut to the sheet's
const CARD_RADIUS = 36;

type Page = { url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean };
type Drag = { from: number; fromY: number; height: number; samples: Sample[] };

const isWeb = (url: string) => /^https?:/.test(url);

const siteOf = (url: string) => (isWeb(url) ? new URL(url).host.replace(/^www\./, "") : "");

function addressOf(typed: string, engine: SearchEngine): string {
	const text = typed.trim();
	if (/^https?:\/\//i.test(text)) return text;
	if (!/\s/.test(text) && /\.[a-z]{2,}(\/|$)/i.test(text)) return `https://${text}`;
	return SEARCH_ENGINES[engine].search + encodeURIComponent(text);
}

class SheetMotion extends Motion {
	constructor(
		readonly sheet: HTMLElement,
		settled: (open: boolean) => void,
	) {
		super(settled);
	}

	begin(fromY: number): Drag {
		return { from: this.position(), fromY, height: this.sheet.offsetHeight, samples: [] };
	}

	follow(drag: Drag, y: number, at: number): void {
		drag.samples = sampled(drag.samples, y, at);
		this.drag(Math.min(1, Math.max(0, drag.from + (y - drag.fromY) / drag.height)));
	}

	protected reveal(shown: boolean): void {
		this.sheet.toggleAttribute("data-shown", shown);
	}

	protected render(position: number): void {
		this.sheet.style.setProperty("--sheet-reveal", String(position));
	}
}

function Address({ url, onGo }: { url: string; onGo: (typed: string) => void }) {
	const [draft, setDraft] = useState<string>();
	return (
		<input
			className="browser-address"
			value={draft ?? siteOf(url)}
			placeholder="網址或關鍵字"
			enterKeyHint="go"
			inputMode="url"
			autoCapitalize="off"
			autoCorrect="off"
			spellCheck={false}
			onFocus={(event) => {
				const input = event.currentTarget;
				setDraft(url.startsWith("about:") ? "" : url);
				requestAnimationFrame(() => input.select());
			}}
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

export const BrowserSheet = memo(function BrowserSheet({
	bot,
	hidden,
	working,
	openKey,
	pullFrom,
	engine,
}: {
	bot: string | undefined;
	hidden: boolean;
	working: boolean;
	openKey: number;
	pullFrom: RefObject<HTMLElement | null>;
	engine: SearchEngine;
}) {
	const [state, setState] = useState<BrowserState>({ active: new Set(), handovers: [] });
	const [pages, setPages] = useState<Readonly<Record<string, Page>>>({});
	const [tabLists, setTabLists] = useState<Readonly<Record<string, BrowserTabs>>>({});
	const [sheet, dispatch] = useReducer(sheetAfter, SHEET_START);
	const frame = useRef<HTMLDivElement>(null);
	const motion = useRef<SheetMotion>(undefined);
	const live = useRef(false);
	const placing = useRef(0);
	const latest = useRef({ bot, open: false, expanded: false, canGoBack: false });

	useEffect(() => browserState.subscribe(setState), []);
	useEffect(() => {
		if (!native.has("Browser")) return;
		const listening = [
			Browser.addListener("page", (page) => setPages((current) => ({ ...current, [`${page.bot}/${page.tab}`]: page }))),
			Browser.addListener("tabs", (list) => setTabLists((current) => ({ ...current, [list.bot]: list }))),
		];
		return () => {
			for (const handle of listening) void handle.then((listener) => listener.remove());
		};
	}, []);

	const active = bot !== undefined && state.active.has(bot);
	const handover = state.handovers.find((item) => item.bot === bot);
	const reason = handover?.reason;
	const tabList = bot ? tabLists[bot] : undefined;
	const page = bot && tabList?.active ? pages[`${bot}/${tabList.active}`] : undefined;
	const expanded = sheet.mode !== "closed";
	const open = expanded && !hidden && bot !== undefined;
	latest.current = { bot, open, expanded, canGoBack: page?.canGoBack ?? false };
	const report = (error: unknown) => dispatch({ type: "failed", message: messageOf(error) });
	const refreshShot = (target: string) =>
		Browser.peek({ bot: target })
			.then((peeked) => {
				if (peeked.jpeg) dispatch({ type: "shot", jpeg: peeked.jpeg });
			})
			.catch(report);
	const openHome = (target: string, tab?: string) => Browser.go({ bot: target, ...(tab ? { tab } : {}), action: "open", url: SEARCH_ENGINES[engine].home });

	const showLive = () => {
		const element = frame.current;
		const target = latest.current.bot;
		if (!element || !target || !latest.current.open) return;
		const box = element.getBoundingClientRect();
		live.current = true;
		Browser.show({ bot: target, x: box.left, y: box.top, width: box.width, height: box.height, radius: CARD_RADIUS }).catch(report);
	};

	const hideLive = async (target: string) => {
		const ticket = ++placing.current;
		await refreshShot(target);
		if (ticket !== placing.current || !live.current) return;
		live.current = false;
		await Browser.hide({ bot: target }).catch(report);
	};

	useEffect(() => {
		dispatch({ type: "bot_changed" });
		if (!bot || !native.has("Browser")) return;
		Browser.tabs({ bot })
			.then((list) => setTabLists((current) => ({ ...current, [list.bot]: list })))
			.catch(report);
	}, [bot]);
	const closesItself = sheet.mode === "auto";
	useEffect(() => {
		if (active) dispatch({ type: "agent_started" });
	}, [active]);
	useEffect(() => {
		if (active || !closesItself || reason !== undefined || working) return;
		const timer = setTimeout(() => dispatch({ type: "agent_finished" }), COLLAPSE_AFTER_MS);
		return () => clearTimeout(timer);
	}, [active, reason, working, closesItself]);
	useEffect(() => {
		if (reason !== undefined) dispatch({ type: "handover" });
	}, [reason]);
	useEffect(() => {
		if (openKey === 0 || !bot) return;
		dispatch({ type: "user_opened" });
	}, [openKey]);

	useEffect(() => {
		if (!bot) return;
		if (open) {
			if (!closesItself) {
				Browser.tabs({ bot })
					.then((list) => {
						const front = list.tabs.find((tab) => tab.id === list.active);
						if (front && isWeb(front.url)) return;
						return openHome(bot);
					})
					.catch(report);
			}
			void refreshShot(bot);
			motion.current?.settle(true);
			return;
		}
		void hideLive(bot);
		motion.current?.settle(false);
	}, [open, bot]);

	useEffect(() => {
		const element = frame.current;
		if (!element || !open) return;
		const resized = new ResizeObserver(() => {
			if (live.current) showLive();
		});
		resized.observe(element);
		return () => resized.disconnect();
	}, [open]);

	const navigate = (target: string, action: "back" | "forward" | "reload") => {
		dispatch({ type: "retried" });
		Browser.go({ bot: target, action }).catch(report);
	};
	const settleTo = (next: boolean) => {
		if (next === latest.current.expanded) motion.current?.settle(next);
		dispatch({ type: "settled", open: next });
	};
	useBack(open, () => {
		const { bot: target, canGoBack } = latest.current;
		if (target && canGoBack) navigate(target, "back");
		else settleTo(false);
	});

	useEffect(() => {
		if (!bot || !native.has("Browser")) return;
		let start: { x: number; y: number; at: number } | undefined;
		let drag: Drag | undefined;
		const onStart = (event: globalThis.TouchEvent) => {
			const touch = event.touches[0];
			const header = pullFrom.current;
			const fromHeader = event.target instanceof Node && header !== null && header.contains(event.target);
			start = touch && fromHeader && !latest.current.open ? { x: touch.clientX, y: touch.clientY, at: event.timeStamp } : undefined;
			drag = undefined;
		};
		const onMove = (event: globalThis.TouchEvent) => {
			const touch = event.touches[0];
			const current = motion.current;
			if (!start || !touch || !current) return;
			const dy = touch.clientY - start.y;
			if (!drag) {
				const intent = intentOf({ dx: dy, dy: touch.clientX - start.x, elapsedMs: event.timeStamp - start.at, selecting: false });
				if (intent === "undecided") return;
				if (intent === "ignore" || dy <= 0) {
					start = undefined;
					return;
				}
				void refreshShot(bot);
				drag = current.begin(touch.clientY);
			}
			current.follow(drag, touch.clientY, event.timeStamp);
		};
		const onEnd = (event: globalThis.TouchEvent) => {
			const current = motion.current;
			if (drag && current) settleTo(settlesOpen(current.position(), velocityOf(drag.samples, event.timeStamp)));
			start = undefined;
			drag = undefined;
		};
		document.addEventListener("touchstart", onStart, { passive: true });
		document.addEventListener("touchmove", onMove, { passive: true });
		document.addEventListener("touchend", onEnd);
		document.addEventListener("touchcancel", onEnd);
		return () => {
			document.removeEventListener("touchstart", onStart);
			document.removeEventListener("touchmove", onMove);
			document.removeEventListener("touchend", onEnd);
			document.removeEventListener("touchcancel", onEnd);
		};
	}, [bot, pullFrom]);

	const pushing = useRef<{ startY: number; drag?: Drag }>(undefined);
	const pushHandlers = {
		onTouchStart: (event: TouchEvent) => {
			const touch = event.touches[0];
			pushing.current = touch ? { startY: touch.clientY } : undefined;
		},
		onTouchMove: (event: TouchEvent) => {
			const touch = event.touches[0];
			const push = pushing.current;
			const current = motion.current;
			if (!touch || !push || !current || !bot) return;
			if (!push.drag) {
				if (Math.abs(touch.clientY - push.startY) <= TOUCH_SLOP) return;
				push.drag = current.begin(touch.clientY);
				void hideLive(bot);
			}
			current.follow(push.drag, touch.clientY, event.timeStamp);
		},
		onTouchEnd: (event: TouchEvent) => {
			const drag = pushing.current?.drag;
			const current = motion.current;
			pushing.current = undefined;
			if (drag && current) settleTo(settlesOpen(current.position(), velocityOf(drag.samples, event.timeStamp)));
		},
	};

	const attachSheet = useCallback((element: HTMLDivElement | null) => {
		if (!element || motion.current?.sheet === element) return;
		motion.current = new SheetMotion(element, (settledOpen) => {
			if (settledOpen) showLive();
		});
		if (latest.current.open) motion.current.settle(true);
	}, []);

	if (!bot || !native.has("Browser")) return null;
	return (
		<div ref={attachSheet} className="browser-sheet" inert={!open}>
			<div className="browser-sheet-bar" {...pushHandlers}>
				<span className="browser-dot" data-active={active || page?.loading || undefined} data-waiting={handover ? true : undefined} />
				<Address
					url={page?.url ?? ""}
					onGo={(typed) => {
						dispatch({ type: "retried" });
						Browser.go({ bot, action: "open", url: addressOf(typed, engine) }).catch(report);
					}}
				/>
				<button type="button" className="browser-nav" aria-label="上一頁" disabled={!page?.canGoBack} onClick={() => navigate(bot, "back")}>
					<BackIcon />
				</button>
				<button type="button" className="browser-nav browser-forward" aria-label="下一頁" disabled={!page?.canGoForward} onClick={() => navigate(bot, "forward")}>
					<BackIcon />
				</button>
				<button type="button" className="browser-nav" aria-label="重新整理" disabled={!page?.url || page.url.startsWith("about:")} onClick={() => navigate(bot, "reload")}>
					<RefreshIcon />
				</button>
				<button type="button" className="browser-nav browser-count" aria-label="分頁" aria-expanded={sheet.strip} onClick={() => dispatch({ type: "strip_toggled" })}>
					{tabList?.tabs.length ?? 0}
				</button>
				{handover ? (
					<button type="button" className="btn primary" onClick={() => browserState.handBack(bot)}>
						交還
					</button>
				) : null}
			</div>
			{sheet.strip ? (
				<div className="browser-tabs">
					{(tabList?.tabs ?? []).map((tab) => (
						<div key={tab.id} className="browser-tab" data-active={tab.id === tabList?.active || undefined}>
							<button type="button" className="browser-tab-name" onClick={() => Browser.selectTab({ bot, tab: tab.id }).catch(report)}>
								{siteOf(pages[`${bot}/${tab.id}`]?.url ?? tab.url) || tab.title || "新分頁"}
							</button>
							<button type="button" className="browser-tab-close" aria-label="關閉分頁" onClick={() => Browser.closeTab({ bot, tab: tab.id }).catch(report)}>
								<CloseIcon size={14} />
							</button>
						</div>
					))}
					{(tabList?.tabs.length ?? 0) < MAX_TABS ? (
						<button type="button" className="browser-tab-new" aria-label="新分頁" onClick={() => Browser.newTab({ bot }).then(({ tab }) => openHome(bot, tab)).catch(report)}>
							<PlusIcon size={16} />
						</button>
					) : null}
				</div>
			) : null}
			{reason || sheet.problem ? <div className="browser-note">{sheet.problem || reason}</div> : null}
			<div ref={frame} className="browser-frame">
				{sheet.shot ? <img className="browser-shot" src={`data:image/jpeg;base64,${sheet.shot}`} alt="" /> : null}
			</div>
			<button type="button" className="browser-grip" aria-label="收起瀏覽器" onClick={() => settleTo(false)} {...pushHandlers} />
		</div>
	);
});
