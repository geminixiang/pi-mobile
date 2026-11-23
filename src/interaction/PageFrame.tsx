import { createContext, useCallback, useContext, useRef, useState } from "react";
import { Type } from "typebox";
import { withCsp } from "../csp.ts";
import { FileIcon } from "pi-mobile-ui/elements";
import { OpenFileContext } from "pi-mobile-ui/message";
import type { Side } from "pi-mobile-ui/gesture";
import { oneOf, check } from "../parse.ts";
import type { Page } from "./pages.ts";
import { promised, useSubscribed } from "pi-mobile-ui/store";

const MIN_HEIGHT = 120;
const MAX_HEIGHT = 2400;
const START_HEIGHT = 240;
const HEIGHT_KEY = "pi-mobile.pageHeight:";

const FrameMessage = Type.Union([Type.Object({ piHeight: Type.Number() }), Type.Object({ piSwipe: oneOf(["left", "right"]) })]);

const FRAME_SCRIPT = `<script>
new ResizeObserver(() => parent.postMessage({ piHeight: document.documentElement.scrollHeight }, "*")).observe(document.documentElement);
let start;
addEventListener("touchstart", (event) => {
	const touch = event.touches[0];
	start = event.touches.length === 1 && !event.target.closest("input, textarea, select, canvas, [contenteditable]") ? { x: touch.clientX, y: touch.clientY } : undefined;
}, { passive: true });
addEventListener("touchmove", (event) => {
	if (!start) return;
	const dx = event.touches[0].clientX - start.x;
	const dy = event.touches[0].clientY - start.y;
	if (Math.hypot(dx, dy) <= 10) return;
	if (Math.abs(dx) > 2 * Math.abs(dy)) parent.postMessage({ piSwipe: dx > 0 ? "left" : "right" }, "*");
	start = undefined;
}, { passive: true });
</script>`;

export type PageHost = { read: (path: string) => Promise<string | undefined>; openSide: (side: Side) => void };

export const PageHostContext = createContext<PageHost | undefined>(undefined);

export function usePageHtml(page: Page): string | undefined {
	const host = useContext(PageHostContext);
	const read = useSubscribed<string | undefined>(undefined, (listener) => (page.html || !host ? undefined : promised(() => host.read(page.path))(listener)), [host, page.html, page.path]);
	return page.html ?? read;
}

export function PageFrame({ page, html }: { page: Page; html: string }) {
	const openFile = useContext(OpenFileContext);
	const host = useContext(PageHostContext);
	const key = HEIGHT_KEY + page.path;
	const [height, setHeight] = useState(() => Number(localStorage.getItem(key)) || START_HEIGHT);
	const latest = useRef({ host, key });
	latest.current = { host, key };
	const hear = useCallback((frame: HTMLIFrameElement) => {
		const listen = (event: MessageEvent) => {
			if (event.source !== frame.contentWindow) return;
			const message = check(FrameMessage, event.data, "page frame");
			if (!message.ok) return;
			if ("piSwipe" in message.value) return latest.current.host?.openSide(message.value.piSwipe);
			const next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(message.value.piHeight)));
			localStorage.setItem(latest.current.key, String(next));
			setHeight(next);
		};
		window.addEventListener("message", listen);
		return () => window.removeEventListener("message", listen);
	}, []);
	return (
		<section className="question-card page-frame-card">
			<iframe ref={hear} className="page-frame" title={page.title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={withCsp(html) + FRAME_SCRIPT} style={{ "--frame-height": `${height}px` }} />
			<button type="button" className="page-frame-open" disabled={!openFile} onClick={() => openFile?.(page.path)}>
				<FileIcon size={18} />
				<span>{page.title}</span>
			</button>
		</section>
	);
}
