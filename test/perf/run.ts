import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PACKAGE = "dev.geminixiang.pimobile";
const VSYNC_MS = 1000 / 120;
const MISSED_MS = VSYNC_MS * 1.5;
const FREEZE_MS = 33;
const MAX_AP_CELSIUS = Number(process.env.PERF_MAX_AP ?? "50");
const MAX_THERMAL_STATUS = Number(process.env.PERF_MAX_THERMAL_STATUS ?? "0");
const SCENES = ["scroll", "stream", "streamscroll", "typing", "panel"] as const;
type Scene = (typeof SCENES)[number];

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
	const at = args.indexOf(`--${name}`);
	return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const serial = option("serial", process.env.ANDROID_SERIAL ?? "");
const port = option("port", process.env.CDP_PORT ?? "9333");
const label = option("label", "run");
const runs = Number(option("runs", "5"));
const scenes = option("scenes", SCENES.join(",")).split(",") as Scene[];
if (!serial) throw new Error("Pass --serial <adb serial>");
const unknown = scenes.filter((scene) => !SCENES.includes(scene));
if (unknown.length > 0) throw new Error(`Unknown scenes: ${unknown.join(", ")}; known: ${SCENES.join(", ")}`);

const adbPath = process.env.ADB ?? `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const adb = (...command: string[]) => execFileSync(adbPath, ["-s", serial, "shell", ...command], { encoding: "utf8" });
const swipe = (x1: number, y1: number, x2: number, y2: number, ms: number) => adb("input", "swipe", String(x1), String(y1), String(x2), String(y2), String(ms));
const tap = (x: number, y: number) => adb("input", "tap", String(x), String(y));

type Reply = { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } };

const PAGE_HELPERS = `
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (predicate, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (predicate()) return true; await sleep(100); } return false; };
const button = (label) => [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label || b.textContent.trim() === label);
const busy = () => Boolean(button("停止") || button("插話"));
const transcript = () => document.querySelector(".transcript");
const center = (element) => { const r = element.getBoundingClientRect(); return { x: Math.round((r.x + r.width / 2) * devicePixelRatio), y: Math.round((r.y + r.height / 2) * devicePixelRatio) }; };
`;

class Page {
	#socket: WebSocket;
	#next = 0;
	#pending = new Map<number, (reply: Reply) => void>();

	private constructor(socket: WebSocket) {
		this.#socket = socket;
		socket.onmessage = (event) => {
			const message = JSON.parse(String(event.data)) as { id?: number; result?: Reply };
			if (message.id !== undefined) this.#pending.get(message.id)?.(message.result ?? {});
		};
	}

	static async connect(): Promise<Page> {
		const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
		const target = targets.find((candidate) => candidate.type === "page");
		if (!target) throw new Error(`No WebView page on tcp:${port}; run .pi/skills/device-testing/scripts/forward.sh`);
		const socket = new WebSocket(target.webSocketDebuggerUrl);
		await new Promise((resolve, reject) => {
			socket.onopen = resolve;
			socket.onerror = reject;
		});
		return new Page(socket);
	}

	async eval<T>(body: string): Promise<T> {
		const id = ++this.#next;
		const expression = `(async () => { ${PAGE_HELPERS} ${body} })()`;
		const reply = new Promise<Reply>((resolve) => this.#pending.set(id, resolve));
		this.#socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
		const { result, exceptionDetails } = await reply;
		if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? JSON.stringify(exceptionDetails));
		return result?.value as T;
	}

	close() {
		this.#socket.close();
	}
}

const START_RECORDING = `
const perf = { frames: [], loaf: [], events: [], observers: [], running: true };
window.__perf = perf;
const observe = (type, options, into) => {
	if (!PerformanceObserver.supportedEntryTypes.includes(type)) return;
	const observer = new PerformanceObserver((list) => into.push(...list.getEntries()));
	observer.observe({ type, ...options });
	perf.observers.push([observer, into]);
};
observe("long-animation-frame", {}, perf.loaf);
observe("event", { durationThreshold: 16 }, perf.events);
let last = performance.now();
const tick = (now) => { perf.frames.push(now - last); last = now; if (perf.running) requestAnimationFrame(tick); };
requestAnimationFrame(tick);
return true;
`;

const STOP_RECORDING = `
const perf = window.__perf;
perf.running = false;
for (const [observer, into] of perf.observers) { into.push(...observer.takeRecords()); observer.disconnect(); }
const scripts = (entry) => (entry.scripts ?? []).map((s) => ({ ms: Math.round(s.duration), invoker: s.invoker, source: (s.sourceFunctionName || "?") + " " + (s.sourceURL || "").split("/").pop() + ":" + s.sourceCharPosition }));
return {
	frames: perf.frames.slice(1),
	loaf: perf.loaf.map((e) => ({ ms: Math.round(e.duration), blocking: Math.round(e.blockingDuration), styleLayout: Math.round(e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0), scripts: scripts(e) })),
	events: perf.events.map((e) => ({ name: e.name, ms: Math.round(e.duration), processing: Math.round(e.processingEnd - e.processingStart), delay: Math.round(e.processingStart - e.startTime) })),
	nodes: document.getElementsByTagName("*").length,
};
`;

type PageResult = {
	frames: number[];
	loaf: { ms: number; blocking: number; styleLayout: number; scripts: { ms: number; invoker: string; source: string }[] }[];
	events: { name: string; ms: number; processing: number; delay: number }[];
	nodes: number;
};

function percentile(sorted: readonly number[], q: number): number {
	if (sorted.length === 0) return 0;
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

const round = (value: number) => Math.round(value * 10) / 10;
const ascending = (values: readonly number[]) => [...values].sort((a, b) => a - b);

function frameSummary(frames: readonly number[]) {
	const sorted = ascending(frames);
	const missed = frames.filter((ms) => ms > MISSED_MS);
	return {
		frames: frames.length,
		hz: round(1000 / percentile(sorted, 0.5)),
		missed: missed.length,
		missedPct: round((missed.length / Math.max(1, frames.length)) * 100),
		droppedVsyncs: missed.reduce((sum, ms) => sum + Math.round(ms / VSYNC_MS) - 1, 0),
		freezes: frames.filter((ms) => ms > FREEZE_MS).length,
		p95: round(percentile(sorted, 0.95)),
		p99: round(percentile(sorted, 0.99)),
		max: round(sorted.at(-1) ?? 0),
	};
}

function gfxSummary(dump: string) {
	const number = (pattern: RegExp) => Number(pattern.exec(dump)?.[1] ?? "NaN");
	const histogram = /^HISTOGRAM: (.*)$/m.exec(dump)?.[1] ?? "";
	const buckets = [...histogram.matchAll(/(\d+)ms=(\d+)/g)].map((match) => [Number(match[1]), Number(match[2])] as const);
	const total = number(/Total frames rendered: (\d+)/);
	const janky = number(/Janky frames: (\d+)/);
	const over = (limit: number) => buckets.filter(([ms]) => ms > limit).reduce((sum, [, count]) => sum + count, 0);
	return {
		frames: total,
		janky,
		jankyPct: round((janky / Math.max(1, total)) * 100),
		over12ms: over(12),
		over33ms: over(33),
		p50: number(/^50th percentile: (\d+)ms/m),
		p90: number(/^90th percentile: (\d+)ms/m),
		p99: number(/^99th percentile: (\d+)ms/m),
		gpuP99: number(/99th gpu percentile: (\d+)ms/),
		missedVsync: number(/Number Missed Vsync: (\d+)/),
		slowUi: number(/Number Slow UI thread: (\d+)/),
		slowDraw: number(/Number Slow issue draw commands: (\d+)/),
		deadlineMissed: number(/Number Frame deadline missed: (\d+)/),
	};
}

function thermal(): { status: number; ap: number; battery: number } {
	const dump = adb("dumpsys", "thermalservice");
	const current = dump.slice(dump.indexOf("Current temperatures from HAL"));
	const celsius = (name: string) => Number(new RegExp(`mValue=([\\d.]+), mType=\\d+, mName=${name},`).exec(current)?.[1] ?? "NaN");
	return { status: Number(/Thermal Status: (\d+)/.exec(dump)?.[1] ?? "NaN"), ap: celsius("AP"), battery: celsius("BAT") };
}

async function coolDown(): Promise<{ status: number; ap: number; battery: number }> {
	for (let waited = 0; ; waited += 15) {
		const now = thermal();
		if (now.status <= MAX_THERMAL_STATUS && !(now.ap > MAX_AP_CELSIUS)) return now;
		if (waited >= 900) throw new Error(`Still hot after 15 minutes: thermal status ${now.status}, AP ${now.ap}°C (limit ${MAX_AP_CELSIUS}°C, PERF_MAX_AP)`);
		console.error(`  thermal status ${now.status}, AP ${now.ap}°C, battery ${now.battery}°C: waiting`);
		await sleep(15_000);
	}
}

async function flings(direction: "older" | "newer", count: number, gap: number) {
	for (let i = 0; i < count; i++) {
		if (direction === "older") swipe(540, 800, 540, 1900, 100);
		else swipe(540, 1900, 540, 800, 100);
		await sleep(gap);
	}
}

async function streamAndWait(page: Page, during?: () => Promise<void>) {
	await page.eval(`await window.piController.send([{ type: "text", text: "stream 500" }]); await until(busy, 5000); return true;`);
	if (during) await during();
	await page.eval(`await until(() => !busy(), 90000); await sleep(500); return true;`);
}

async function act(page: Page, scene: Scene) {
	switch (scene) {
		case "scroll":
			await flings("older", 3, 1500);
			await flings("newer", 3, 1500);
			return;
		case "stream":
			return streamAndWait(page);
		case "streamscroll":
			return streamAndWait(page, async () => {
				await sleep(1500);
				await flings("older", 2, 1200);
				await flings("newer", 2, 1200);
			});
		case "typing":
			for (const key of "abcdefghijklmnopqrstuvwxyzabcd") adb("input", "text", key);
			await sleep(500);
			return;
		case "panel":
			for (let i = 0; i < 3; i++) {
				const { x, y } = await page.eval<{ x: number; y: number }>(`return center(button("Bot 列表"));`);
				tap(x, y);
				await sleep(1200);
				swipe(800, 1200, 50, 1200, 150);
				await sleep(1200);
			}
			return;
	}
}

async function prepare(page: Page, scene: Scene) {
	await page.eval(`await until(() => window.piController && !busy(), 60000); document.activeElement?.blur(); transcript().scrollTop = 1e9; await sleep(800); return true;`);
	if (scene !== "typing") return;
	const { x, y } = await page.eval<{ x: number; y: number }>(`return center(document.querySelector(".composer textarea"));`);
	tap(x, y);
	await sleep(1200);
}

async function finish(page: Page, scene: Scene) {
	if (scene !== "typing") return;
	await page.eval(`
		const area = document.querySelector(".composer textarea");
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(area, "");
		area.dispatchEvent(new Event("input", { bubbles: true }));
		area.blur();
		await sleep(800);
		return true;
	`);
}

async function measure(page: Page, scene: Scene) {
	await prepare(page, scene);
	const heat = await coolDown();
	adb("dumpsys", "gfxinfo", PACKAGE, "reset");
	await page.eval(START_RECORDING);
	await act(page, scene);
	const result = await page.eval<PageResult>(STOP_RECORDING);
	const gfx = gfxSummary(adb("dumpsys", "gfxinfo", PACKAGE));
	await finish(page, scene);
	const eventMs = ascending(result.events.map((event) => event.ms));
	return {
		heat,
		nodes: result.nodes,
		gfx,
		raf: frameSummary(result.frames),
		loaf: {
			count: result.loaf.length,
			blockingMs: result.loaf.reduce((sum, entry) => sum + entry.blocking, 0),
			worst: [...result.loaf].sort((a, b) => b.ms - a.ms).slice(0, 3),
		},
		input: { slow: result.events.length, p95: percentile(eventMs, 0.95), worst: [...result.events].sort((a, b) => b.ms - a.ms).slice(0, 3) },
	};
}

type Sample = Awaited<ReturnType<typeof measure>>;

const page = await Page.connect();
const checked = await page.eval<{ bot: string; rafHz: number }>(`
	const bots = await window.piRuntime.bots();
	const bot = bots.find((b) => b.id === window.piController?.id);
	const intervals = [];
	let last = performance.now();
	await new Promise((resolve) => { const tick = (now) => { intervals.push(now - last); last = now; if (intervals.length < 240) requestAnimationFrame(tick); else resolve(); }; requestAnimationFrame(tick); });
	intervals.sort((a, b) => a - b);
	return { bot: bot?.name ?? "", rafHz: Math.round(1000 / intervals[120]) };
`);
if (!/^(test|tmp|測試)/i.test(checked.bot)) throw new Error(`Open the test bot first (name starting test, tmp, or 測試); open is "${checked.bot}". See docs/development.md`);
if (checked.rafHz < 110) throw new Error(`The page runs at ${checked.rafHz} Hz, not 120: set 動態流暢度 to 自適應 or 高 and keep the screen on.`);

const charging = /AC powered: true|USB powered: true|Wireless powered: true/.test(adb("dumpsys", "battery"));
if (charging) console.error("The phone is charging: it runs warmer and may throttle. Unplug it for numbers you will compare.");
const report = { label, at: new Date().toISOString(), device: adb("getprop", "ro.product.model").trim(), charging, bot: checked.bot, rafHz: checked.rafHz, runs, scenes: {} as Record<string, { median: Record<string, number>; runs: Sample[] }> };
for (const scene of scenes) {
	console.error(`${scene}: warm-up`);
	await measure(page, scene);
	const samples: Sample[] = [];
	for (let run = 1; run <= runs; run++) {
		console.error(`${scene}: ${run}/${runs}`);
		samples.push(await measure(page, scene));
	}
	const median = (get: (sample: Sample) => number) => percentile(ascending(samples.map(get)), 0.5);
	report.scenes[scene] = {
		median: {
			gfxFrames: median((s) => s.gfx.frames),
			gfxJankyPct: median((s) => s.gfx.jankyPct),
			gfxOver12ms: median((s) => s.gfx.over12ms),
			gfxOver33ms: median((s) => s.gfx.over33ms),
			gfxP90: median((s) => s.gfx.p90),
			gfxP99: median((s) => s.gfx.p99),
			gpuP99: median((s) => s.gfx.gpuP99),
			rafMissedPct: median((s) => s.raf.missedPct),
			rafDroppedVsyncs: median((s) => s.raf.droppedVsyncs),
			rafFreezes: median((s) => s.raf.freezes),
			rafP99: median((s) => s.raf.p99),
			loafBlockingMs: median((s) => s.loaf.blockingMs),
			inputP95: median((s) => s.input.p95),
		},
		runs: samples,
	};
}
page.close();

mkdirSync("test/perf/out", { recursive: true });
const file = `test/perf/out/${label}.json`;
writeFileSync(file, `${JSON.stringify(report, null, "\t")}\n`);
const rows = Object.entries(report.scenes).map(([scene, { median }]) => ({ scene, ...median }));
const baseline = option("compare", "");
if (baseline) {
	const before = JSON.parse(readFileSync(baseline, "utf8")) as typeof report;
	console.table(rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, before.scenes[row.scene]?.median[key] === undefined ? value : `${before.scenes[row.scene]?.median[key]} → ${value}`]))));
} else {
	console.table(rows);
}
console.log(file);
