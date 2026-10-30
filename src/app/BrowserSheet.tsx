import { type RefObject, type TouchEvent, useEffect, useRef, useState } from "react";
import { type BrowserState, browserState, markUsed } from "../agent/tools/browser.ts";
import { native } from "../native.ts";
import { Browser, type BrowserTabs } from "../plugins/browser.ts";
import { messageOf } from "../promise.ts";
import type { SearchEngine } from "../settings.ts";
import { BackIcon, CloseIcon, PlusIcon, RefreshIcon } from "./icons.tsx";
import { useBack } from "./layers.ts";
import { SETTLE_MS, settleCurve, settlesOpen, velocityOf } from "./sideGesture.ts";

const COLLAPSE_AFTER_MS = 1500;
const MAX_TABS = 4;
// why: --card-radius; the page reaches the sheet's bottom edge, so its corners are cut to the sheet's
const CARD_RADIUS = 36;
const SLOP = 10;

type Page = { url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean };
type Drag = { from: number; fromY: number; samples: { x: number; t: number }[] };

const hostOf = (url: string) => (/^https?:/.test(url) ? new URL(url).host.replace(/^www\./, "") : "");

const ENGINES: Record<SearchEngine, { home: string; search: (query: string) => string }> = {
	duckduckgo: { home: "https://duckduckgo.com/", search: (query) => `https://duckduckgo.com/?q=${encodeURIComponent(query)}` },
	google: { home: "https://www.google.com/", search: (query) => `https://www.google.com/search?q=${encodeURIComponent(query)}` },
};

function addressOf(typed: string, engine: SearchEngine): string {
	const text = typed.trim();
	if (/^https?:\/\//i.test(text)) return text;
	if (!/\s/.test(text) && /\.[a-z]{2,}(\/|$)/i.test(text)) return `https://${text}`;
	return ENGINES[engine].search(text);
}

class SheetMotion {
	#position = 0;
	#frame = 0;

	constructor(
		readonly sheet: HTMLElement,
		private readonly settled: (open: boolean) => void,
	) {}

	position(): number {
		return this.#position;
	}

	height(): number {
		return this.sheet.offsetHeight;
	}

	drag(position: number): void {
		this.#stop();
		this.sheet.toggleAttribute("data-shown", true);
		this.#place(position);
	}

	settle(open: boolean): void {
		this.#stop();
		if (open) this.sheet.toggleAttribute("data-shown", true);
		const from = this.#position;
		const target = open ? 1 : 0;
		const started = performance.now();
		const step = (now: number) => {
			const progress = from === target ? 1 : (now - started) / SETTLE_MS;
			this.#place(from + (target - from) * settleCurve(progress));
			if (progress < 1) {
				this.#frame = requestAnimationFrame(step);
				return;
			}
			this.#frame = 0;
			if (!open) this.sheet.toggleAttribute("data-shown", false);
			this.settled(open);
		};
		step(started);
	}

	#stop(): void {
		cancelAnimationFrame(this.#frame);
		this.#frame = 0;
	}

	#place(position: number): void {
		this.#position = position;
		this.sheet.style.setProperty("--sheet-reveal", String(position));
	}
}

function Address({ url, onGo }: { url: string; onGo: (typed: string) => void }) {
	const [draft, setDraft] = useState<string>();
	return (
		<input
			className="browser-address"
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

export function BrowserSheet({
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
	const [state, setState] = useState<BrowserState>({ used: new Set(), active: new Set(), handovers: [] });
	const [pages, setPages] = useState<Readonly<Record<string, Page>>>({});
	const [tabLists, setTabLists] = useState<Readonly<Record<string, BrowserTabs>>>({});
	const [strip, setStrip] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const [shot, setShot] = useState<string>();
	const [problem, setProblem] = useState("");
	const sheet = useRef<HTMLDivElement>(null);
	const frame = useRef<HTMLDivElement>(null);
	const motion = useRef<SheetMotion>(undefined);
	const auto = useRef(false);
	const live = useRef(false);
	const placing = useRef(0);
	const latest = useRef({ bot, open: false });

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
	const open = expanded && !hidden && bot !== undefined;
	latest.current = { bot, open };

	const showLive = () => {
		const element = frame.current;
		const target = latest.current.bot;
		if (!element || !target || !latest.current.open) return;
		const box = element.getBoundingClientRect();
		live.current = true;
		Browser.show({ bot: target, x: box.left, y: box.top, width: box.width, height: box.height, radius: CARD_RADIUS }).catch((error: unknown) => setProblem(messageOf(error)));
	};

	const hideLive = async (target: string) => {
		const ticket = ++placing.current;
		const peeked = await Browser.peek({ bot: target }).catch((error: unknown) => {
			setProblem(messageOf(error));
			return { jpeg: undefined };
		});
		if (ticket !== placing.current) return;
		if (peeked.jpeg) setShot(peeked.jpeg);
		if (!live.current) return;
		live.current = false;
		await Browser.hide({ bot: target }).catch((error: unknown) => setProblem(messageOf(error)));
	};

	useEffect(() => {
		setExpanded(false);
		setProblem("");
		setShot(undefined);
		setStrip(false);
		auto.current = false;
		if (!bot || !native.has("Browser")) return;
		Browser.tabs({ bot })
			.then((list) => setTabLists((current) => ({ ...current, [list.bot]: list })))
			.catch((error: unknown) => setProblem(messageOf(error)));
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

	useEffect(() => {
		if (!bot) return;
		if (open) {
			if (!auto.current) {
				Browser.tabs({ bot })
					.then((list) => {
						const front = list.tabs.find((tab) => tab.id === list.active);
						if (front && /^https?:/.test(front.url)) return;
						return Browser.act({ bot, steps: [{ action: "open", url: ENGINES[engine].home }], screenshot: false }).then(() => undefined);
					})
					.catch((error: unknown) => setProblem(messageOf(error)));
			}
			void Browser.peek({ bot })
				.then((peeked) => {
					if (peeked.jpeg) setShot(peeked.jpeg);
				})
				.catch((error: unknown) => setProblem(messageOf(error)));
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

	const navigate = (action: "back" | "forward" | "reload") => {
		if (!bot) return;
		setProblem("");
		Browser.act({ bot, steps: [{ action }], screenshot: false }).catch((error: unknown) => setProblem(messageOf(error)));
	};
	const switchTab = (tab: string) => {
		if (!bot) return;
		Browser.selectTab({ bot, tab }).catch((error: unknown) => setProblem(messageOf(error)));
	};
	const closeTab = (tab: string) => {
		if (!bot) return;
		Browser.closeTab({ bot, tab }).catch((error: unknown) => setProblem(messageOf(error)));
	};
	const openTab = () => {
		if (!bot) return;
		Browser.newTab({ bot })
			.then(({ tab }) => Browser.act({ bot, tab, steps: [{ action: "open", url: ENGINES[engine].home }], screenshot: false }))
			.catch((error: unknown) => setProblem(messageOf(error)));
	};
	const collapse = () => {
		auto.current = false;
		setExpanded(false);
	};
	const pageRef = useRef(page);
	pageRef.current = page;
	useBack(open, () => {
		if (bot && pageRef.current?.canGoBack) navigate("back");
		else collapse();
	});

	const settleTo = (next: boolean) => {
		auto.current = false;
		if (next === expanded) motion.current?.settle(next);
		else setExpanded(next);
	};

	const settleRef = useRef(settleTo);
	settleRef.current = settleTo;
	useEffect(() => {
		if (!bot || !native.has("Browser")) return;
		let start: { x: number; y: number } | undefined;
		let drag: Drag | undefined;
		const onStart = (event: globalThis.TouchEvent) => {
			const touch = event.touches[0];
			const header = pullFrom.current;
			const fromHeader = event.target instanceof Node && header !== null && header.contains(event.target);
			start = touch && fromHeader && !latest.current.open ? { x: touch.clientX, y: touch.clientY } : undefined;
			drag = undefined;
		};
		const onMove = (event: globalThis.TouchEvent) => {
			const touch = event.touches[0];
			const current = motion.current;
			if (!start || !touch || !current) return;
			const dy = touch.clientY - start.y;
			if (!drag) {
				if (Math.hypot(touch.clientX - start.x, dy) <= SLOP) return;
				if (dy <= 0 || Math.abs(dy) < 2 * Math.abs(touch.clientX - start.x)) {
					start = undefined;
					return;
				}
				markUsed(bot);
				void Browser.peek({ bot })
					.then((peeked) => {
						if (peeked.jpeg) setShot(peeked.jpeg);
					})
					.catch((error: unknown) => setProblem(messageOf(error)));
				drag = { from: 0, fromY: touch.clientY, samples: [] };
			}
			drag.samples = [...drag.samples.slice(-7), { x: touch.clientY, t: event.timeStamp }];
			current.drag(Math.min(1, Math.max(0, (touch.clientY - drag.fromY) / current.height())));
		};
		const onEnd = (event: globalThis.TouchEvent) => {
			const current = motion.current;
			if (drag && current) settleRef.current(settlesOpen(current.position(), velocityOf(drag.samples, event.timeStamp)));
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

	const pushing = useRef<Drag & { started: boolean; startY: number }>(undefined);
	const pushHandlers = {
		onTouchStart: (event: TouchEvent) => {
			const touch = event.touches[0];
			const current = motion.current;
			if (!touch || !current) return;
			pushing.current = { from: current.position(), fromY: touch.clientY, startY: touch.clientY, samples: [], started: false };
		},
		onTouchMove: (event: TouchEvent) => {
			const touch = event.touches[0];
			const push = pushing.current;
			const current = motion.current;
			if (!touch || !push || !current || !bot) return;
			if (!push.started) {
				if (Math.abs(touch.clientY - push.startY) <= SLOP) return;
				push.started = true;
				push.fromY = touch.clientY;
				void hideLive(bot);
			}
			push.samples = [...push.samples.slice(-7), { x: touch.clientY, t: event.timeStamp }];
			current.drag(Math.min(1, Math.max(0, push.from + (touch.clientY - push.fromY) / current.height())));
		},
		onTouchEnd: (event: TouchEvent) => {
			const push = pushing.current;
			const current = motion.current;
			pushing.current = undefined;
			if (!push?.started || !current) return;
			const next = settlesOpen(current.position(), velocityOf(push.samples, event.timeStamp));
			if (next) motion.current?.settle(true);
			else settleTo(false);
		},
	};

	if (!bot || !native.has("Browser")) return null;
	const go = (typed: string) => {
		setProblem("");
		Browser.act({ bot, steps: [{ action: "open", url: addressOf(typed, engine) }], screenshot: false }).catch((error: unknown) => setProblem(messageOf(error)));
	};
	const dot = <span className="browser-dot" data-active={active || page?.loading || undefined} data-waiting={handover ? true : undefined} />;
	return (
		<div
			ref={(element) => {
				sheet.current = element;
				if (!element || motion.current?.sheet === element) return;
				motion.current = new SheetMotion(element, (settledOpen) => {
					if (settledOpen) showLive();
				});
				if (latest.current.open) motion.current.settle(true);
			}}
			className="browser-sheet"
			inert={!open}
		>
			<div className="browser-sheet-bar" {...pushHandlers}>
				{dot}
				<Address url={page?.url ?? ""} onGo={go} />
				<button type="button" className="browser-nav" aria-label="上一頁" disabled={!page?.canGoBack} onClick={() => navigate("back")}>
					<BackIcon />
				</button>
				<button type="button" className="browser-nav browser-forward" aria-label="下一頁" disabled={!page?.canGoForward} onClick={() => navigate("forward")}>
					<BackIcon />
				</button>
				<button type="button" className="browser-nav" aria-label="重新整理" disabled={!page?.url || page.url.startsWith("about:")} onClick={() => navigate("reload")}>
					<RefreshIcon />
				</button>
				<button type="button" className="browser-nav browser-count" aria-label="分頁" aria-expanded={strip} onClick={() => setStrip((shown) => !shown)}>
					{tabList?.tabs.length ?? 0}
				</button>
				{handover ? (
					<button type="button" className="btn primary" onClick={() => browserState.handBack(bot)}>
						交還
					</button>
				) : null}
			</div>
			{strip ? (
				<div className="browser-tabs">
					{(tabList?.tabs ?? []).map((tab) => (
						<div key={tab.id} className="browser-tab" data-active={tab.id === tabList?.active || undefined}>
							<button type="button" className="browser-tab-name" onClick={() => switchTab(tab.id)}>
								{hostOf(pages[`${bot}/${tab.id}`]?.url ?? tab.url) || tab.title || "新分頁"}
							</button>
							<button type="button" className="browser-tab-close" aria-label="關閉分頁" onClick={() => closeTab(tab.id)}>
								<CloseIcon size={14} />
							</button>
						</div>
					))}
					{(tabList?.tabs.length ?? 0) < MAX_TABS ? (
						<button type="button" className="browser-tab-new" aria-label="新分頁" onClick={openTab}>
							<PlusIcon size={16} />
						</button>
					) : null}
				</div>
			) : null}
			{reason || problem ? <div className="browser-note">{problem || reason}</div> : null}
			<div ref={frame} className="browser-frame">
				{shot ? <img className="browser-shot" src={`data:image/jpeg;base64,${shot}`} alt="" /> : null}
			</div>
			<button type="button" className="browser-grip" aria-label="收起瀏覽器" onClick={collapse} {...pushHandlers} />
		</div>
	);
}
