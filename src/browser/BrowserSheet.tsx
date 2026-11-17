import { memo, type RefObject, type TouchEvent, useCallback, useRef, useState } from "react";
import { cell, type Source, useStore } from "../ui/subscribed.ts";
import { type BrowserState, browserState, NO_BROWSER } from "./tool.ts";
import { native } from "../native.ts";
import { Browser, MAX_TABS } from "./plugin.ts";
import { messageOf } from "../promise.ts";
import { SEARCH_ENGINES, type SearchEngine } from "../settings.ts";
import { NOTHING_SHOWN, pageKey, sameInputs, SHEET_START, type SheetEvent, type SheetInputs, sheetAfter, sheetOpen, type SheetState, withPage, withTabs } from "./sheetState.ts";
import { BackIcon, CloseIcon, PlusIcon, RefreshIcon } from "../ui/icons.tsx";
import { isBack } from "../ui/layers.ts";
import { intentOf, Motion, type Sample, sampled, settlesOpen, TOUCH_SLOP, velocityOf } from "../ui/sideGesture.ts";
import { haptic } from "../ui/haptics.ts";
import { type Cancel, nextFrame } from "../time.ts";

// why: --card-radius; the page reaches the sheet's bottom edge, so its corners are cut to the sheet's
const CARD_RADIUS = 36;

type Drag = { from: number; fromY: number; height: number; samples: Sample[] };

const SPACE = /\s/;
const DOMAIN_END = /\.[a-z]{2,}(\/|$)/i;

const isWeb = (url: string) => url.startsWith("http:") || url.startsWith("https:");

function siteOf(url: string): string {
	if (!isWeb(url)) return "";
	const host = new URL(url).host;
	return host.startsWith("www.") ? host.slice("www.".length) : host;
}

function addressOf(typed: string, engine: SearchEngine): string {
	const text = typed.trim();
	if (isWeb(text.toLowerCase())) return text;
	if (!SPACE.test(text) && DOMAIN_END.test(text)) return `https://${text}`;
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
	const selecting = useRef<Cancel>(undefined);
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
				selecting.current = nextFrame(() => input.select());
			}}
			onBlur={() => {
				selecting.current?.();
				setDraft(undefined);
			}}
			onChange={(event) => setDraft(event.target.value)}
			onKeyDown={(event) => {
				if (event.key !== "Enter" || !draft?.trim()) return;
				onGo(draft);
				event.currentTarget.blur();
			}}
		/>
	);
}

const asked = cell(0);

export const askForBrowser = () => void asked.set((count) => count + 1);

export type BrowserScreen = Pick<SheetInputs, "bot" | "asking" | "hidden">;

export const BrowserSheet = memo(function BrowserSheet({ screen, pullFrom, engine }: { screen: Source<BrowserScreen>; pullFrom: RefObject<HTMLElement | null>; engine: SearchEngine }) {
	const frame = useRef<HTMLDivElement>(null);
	const motion = useRef<SheetMotion>(undefined);
	const live = useRef(false);
	const placing = useRef(0);
	const latest = useRef({ engine, pullFrom });
	latest.current = { engine, pullFrom };

	const [state, , browser] = useStore<BrowserState>(NO_BROWSER, (set) => browserState.subscribe(set), []);
	const [shown, setShown] = useStore(
		NOTHING_SHOWN,
		(set) => {
			if (!native.has("Browser")) return undefined;
			const listening = [Browser.addListener("page", (page) => set((current) => withPage(current, page))), Browser.addListener("tabs", (list) => set((current) => withTabs(current, list)))];
			return () => {
				for (const handle of listening) void handle.then((listener) => listener.remove());
			};
		},
		[],
	);
	const [sheet, setSheet, sheetNow] = useStore<SheetState>(
		SHEET_START,
		() => {
			const see = () => {
				const seen = screen.read();
				const inputs: SheetInputs = { ...seen, handover: browser.read().handovers.find((item) => item.bot === seen.bot)?.reason, openKey: asked.read() };
				if (!sameInputs(sheetNow.read().inputs, inputs)) step({ type: "inputs", inputs });
			};
			const stops = [screen.subscribe(see), browser.subscribe(see), asked.subscribe(see)];
			see();
			return () => {
				for (const stop of stops) stop();
			};
		},
		[screen],
	);

	const report = (error: unknown) => step({ type: "failed", message: messageOf(error) });
	const refreshShot = (target: string) =>
		Browser.peek({ bot: target })
			.then((peeked) => {
				if (peeked.jpeg) step({ type: "shot", jpeg: peeked.jpeg });
			})
			.catch(report);
	const openHome = (target: string, tab?: string) => Browser.go({ bot: target, ...(tab ? { tab } : {}), action: "open", url: SEARCH_ENGINES[latest.current.engine].home });

	const showLive = () => {
		const element = frame.current;
		const now = sheetNow.read();
		const target = now.inputs.bot;
		if (!element || !target || !sheetOpen(now)) return;
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

	const follow = (before: SheetState, after: SheetState) => {
		const target = after.inputs.bot;
		if (!target || !native.has("Browser")) return;
		const open = sheetOpen(after);
		if (target !== before.inputs.bot) {
			Browser.tabs({ bot: target })
				.then((list) => setShown((current) => withTabs(current, list)))
				.catch(report);
		} else if (open === sheetOpen(before)) return;
		if (!open) {
			void hideLive(target);
			motion.current?.settle(false);
			return;
		}
		if (after.mode === "open") {
			Browser.tabs({ bot: target })
				.then((list) => {
					const front = list.tabs.find((tab) => tab.id === list.active);
					if (front && isWeb(front.url)) return;
					return openHome(target);
				})
				.catch(report);
		}
		void refreshShot(target);
		motion.current?.settle(true);
	};
	const step = (event: SheetEvent) => {
		const before = sheetNow.read();
		follow(before, setSheet(sheetAfter(before, event)));
	};

	const attach = useCallback((element: HTMLDivElement) => {
		motion.current = new SheetMotion(element, (settledOpen) => {
			if (settledOpen) showLive();
		});
		if (sheetOpen(sheetNow.read())) motion.current.settle(true);
		return () => undefined;
	}, []);
	const followSize = useCallback((element: HTMLDivElement) => {
		frame.current = element;
		const resized = new ResizeObserver(() => {
			if (live.current) showLive();
		});
		resized.observe(element);
		return () => resized.disconnect();
	}, []);

	const bot = sheet.inputs.bot;
	const open = sheetOpen(sheet);
	const active = bot !== undefined && state.active.has(bot);
	const handover = state.handovers.find((item) => item.bot === bot);
	const reason = handover?.reason;
	const tabList = bot ? shown.tabs[bot] : undefined;
	const page = bot && tabList?.active ? shown.pages[pageKey(bot, tabList.active)] : undefined;

	const navigate = (target: string, action: "back" | "forward" | "reload") => {
		step({ type: "retried" });
		Browser.go({ bot: target, action }).catch(report);
	};
	const settleTo = (next: boolean) => {
		const wasOpen = sheetOpen(sheetNow.read());
		step({ type: "settled", open: next });
		const isOpen = sheetOpen(sheetNow.read());
		if (isOpen === wasOpen) motion.current?.settle(isOpen);
	};
	const settleByHand = (next: boolean) => {
		if (next !== (sheetNow.read().mode !== "closed")) haptic(next ? "press" : "tick");
		settleTo(next);
	};

	const pullFromHeader = useCallback(() => {
		let start: { x: number; y: number; at: number } | undefined;
		let drag: Drag | undefined;
		const onStart = (event: globalThis.TouchEvent) => {
			const touch = event.touches[0];
			const header = latest.current.pullFrom.current;
			const fromHeader = event.target instanceof Node && header !== null && header.contains(event.target);
			start = touch && fromHeader && !sheetOpen(sheetNow.read()) ? { x: touch.clientX, y: touch.clientY, at: event.timeStamp } : undefined;
			drag = undefined;
		};
		const onMove = (event: globalThis.TouchEvent) => {
			const touch = event.touches[0];
			const current = motion.current;
			const target = sheetNow.read().inputs.bot;
			if (!start || !touch || !current || !target) return;
			const dy = touch.clientY - start.y;
			if (!drag) {
				const intent = intentOf({ dx: dy, dy: touch.clientX - start.x, elapsedMs: event.timeStamp - start.at, selecting: false });
				if (intent === "undecided") return;
				if (intent === "ignore" || dy <= 0) {
					start = undefined;
					return;
				}
				void refreshShot(target);
				drag = current.begin(touch.clientY);
			}
			current.follow(drag, touch.clientY, event.timeStamp);
		};
		const onEnd = (event: globalThis.TouchEvent) => {
			const current = motion.current;
			if (drag && current) settleByHand(settlesOpen(current.position(), velocityOf(drag.samples, event.timeStamp)));
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
	}, []);

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
			if (drag && current) settleByHand(settlesOpen(current.position(), velocityOf(drag.samples, event.timeStamp)));
		},
	};

	if (!bot || !native.has("Browser")) return null;
	return (
		<div
			ref={attach}
			className="browser-sheet"
			inert={!open}
			data-back={open || undefined}
			onKeyDown={(event) => {
				if (!isBack(event)) return;
				if (page?.canGoBack) navigate(bot, "back");
				else settleTo(false);
			}}
		>
			<div ref={pullFromHeader} className="browser-sheet-bar" {...pushHandlers}>
				<span className="browser-dot" data-active={active || page?.loading || undefined} data-waiting={handover ? true : undefined} />
				<Address
					url={page?.url ?? ""}
					onGo={(typed) => {
						step({ type: "retried" });
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
				<button type="button" className="browser-nav browser-count" aria-label="分頁" aria-expanded={sheet.strip} onClick={() => step({ type: "strip_toggled" })}>
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
								{siteOf(shown.pages[pageKey(bot, tab.id)]?.url ?? tab.url) || tab.title || "新分頁"}
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
			<div ref={followSize} className="browser-frame">
				{sheet.shot ? <img className="browser-shot" src={`data:image/jpeg;base64,${sheet.shot}`} alt="" /> : null}
			</div>
			<button type="button" className="browser-grip" aria-label="收起瀏覽器" onClick={() => settleTo(false)} {...pushHandlers} />
		</div>
	);
});
