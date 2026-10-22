// Leave pi for a while, come back, and trace what the WebView does in the first seconds back: a Chrome trace of the
// whole time (open it in chrome://tracing, or read it with resume-analyze.mjs), and from the page the frame gaps,
// long tasks, and resize/visibility events after it became visible. Leaves with HOME, or into another app with
// AWAY_APP=<package> (it opens a web page there, e.g. AWAY_APP=com.android.chrome).
// Usage: node resume-trace.mjs <port> <adb serial> <seconds away> [out.json]
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const [port, serial, away = "60", out = "/tmp/resume-trace.json"] = process.argv.slice(2);
if (!port || !serial) throw new Error("usage: node resume-trace.mjs <port> <adb serial> <seconds away> [out.json]");
const ADB = `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const adb = (...args) => execFileSync(ADB, ["-s", serial, ...args]).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
let id = 0;
const pending = new Map();
const events = [];
let traceDone;
ws.onmessage = (m) => {
	const msg = JSON.parse(String(m.data));
	if (msg.id !== undefined) pending.get(msg.id)?.(msg.result ?? msg.error);
	else if (msg.method === "Tracing.dataCollected") events.push(...msg.params.value);
	else if (msg.method === "Tracing.tracingComplete") traceDone?.();
};
const send = (method, params = {}) => {
	const n = ++id;
	ws.send(JSON.stringify({ id: n, method, params }));
	return new Promise((r) => pending.set(n, r));
};
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;

// In the page: when it becomes visible, frame gaps and long tasks for 5 s.
await evaluate(`(() => {
	const rec = (window.__resume = { visibleAt: 0, frames: [], long: [], events: [] });
	new PerformanceObserver((list) => { for (const e of list.getEntries()) if (rec.visibleAt) rec.long.push([Math.round(e.startTime - rec.visibleAt), Math.round(e.duration)]); }).observe({ type: "longtask" });
	for (const name of ["resize"]) addEventListener(name, () => rec.events.push([name, innerWidth + "x" + innerHeight, Math.round(performance.now())]));
	visualViewport?.addEventListener("resize", () => rec.events.push(["vv-resize", visualViewport.width + "x" + visualViewport.height, Math.round(performance.now())]));
	new MutationObserver((ms) => { for (const m of ms) rec.events.push(["root-attr", m.attributeName + "=" + String(document.documentElement.getAttribute(m.attributeName)).slice(0, 160), Math.round(performance.now())]); }).observe(document.documentElement, { attributes: true });
	new MutationObserver((ms) => rec.events.push(["head", ms.length, Math.round(performance.now())])).observe(document.head, { childList: true, subtree: true, attributes: true });
	for (const name of ["visibilitychange", "focus", "resume", "pageshow"]) addEventListener(name, () => rec.events.push([name, document.visibilityState, Math.round(performance.now())]), true);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState !== "visible") return;
		rec.visibleAt = performance.now();
		let last = rec.visibleAt;
		const tick = (t) => { rec.frames.push(Math.round(t - last)); last = t; if (t - rec.visibleAt < 5000) requestAnimationFrame(tick); };
		requestAnimationFrame(tick);
	});
	return 1;
})()`);

const categories = [
	"devtools.timeline",
	"disabled-by-default-devtools.timeline",
	"disabled-by-default-devtools.timeline.frame",
	"blink.user_timing",
	"toplevel",
	"v8.execute",
	"disabled-by-default-v8.cpu_profiler",
].join(",");
await send("Tracing.start", { categories, transferMode: "ReportEvents" });
if (process.env.AWAY_APP) adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", "https://www.wikipedia.org/", process.env.AWAY_APP);
else adb("shell", "input", "keyevent", "KEYCODE_HOME");
await sleep(Number(away) * 1000);
const backAt = Date.now();
adb("shell", "am", "start", "-n", "dev.geminixiang.pimobile/.MainActivity");
await sleep(6000);
const done = new Promise((r) => (traceDone = r));
await send("Tracing.end");
await done;
const rec = await evaluate("JSON.stringify(window.__resume)");
writeFileSync(out, JSON.stringify({ traceEvents: events }));
console.log(JSON.stringify({ away: Number(away), resumeCommandMs: Date.now() - backAt, page: JSON.parse(rec ?? "{}"), traceEvents: events.length, out }));
ws.close();
