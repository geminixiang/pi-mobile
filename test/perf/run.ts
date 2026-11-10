import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Page, touches } from "../device/page.ts";

const PACKAGE = "dev.geminixiang.pimobile";
const MAX_AP_CELSIUS = Number(process.env.PERF_MAX_AP ?? "50");
const MAX_THERMAL_STATUS = Number(process.env.PERF_MAX_THERMAL_STATUS ?? "0");
const SCENES = ["scroll", "stream", "streamscroll", "typing", "panel"] as const;
type Scene = (typeof SCENES)[number];

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
	const at = args.indexOf(`--${name}`);
	return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const ios = args.includes("--ios");
const serial = option("serial", process.env.ANDROID_SERIAL ?? "");
const port = option("port", process.env.CDP_PORT ?? "9333");
const label = option("label", "run");
const runs = Number(option("runs", "5"));
const IOS_SCENES: readonly Scene[] = ["scroll", "stream", "streamscroll", "panel"];
const scenes = option("scenes", (ios ? IOS_SCENES : SCENES).join(",")).split(",") as Scene[];
if (!ios && !serial) throw new Error("Pass --serial <adb serial>, or --ios for the iPhone");
const unknown = scenes.filter((scene) => !SCENES.includes(scene));
if (unknown.length > 0) throw new Error(`Unknown scenes: ${unknown.join(", ")}; known: ${SCENES.join(", ")}`);
const unsupported = ios ? scenes.filter((scene) => !IOS_SCENES.includes(scene)) : [];
if (unsupported.length > 0) throw new Error(`The iPhone cannot run ${unsupported.join(", ")}: nothing can type on it from this Mac`);

const TYPING_GAP_MS = 120;

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
	events: perf.events.map((e) => ({ name: e.name, ms: Math.round(e.duration), processing: Math.round((e.processingEnd - e.processingStart) * 10) / 10, delay: Math.round(e.processingStart - e.startTime) })),
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

function frameSummary(frames: readonly number[], vsyncMs: number) {
	const sorted = ascending(frames);
	const missed = frames.filter((ms) => ms > vsyncMs * 1.5);
	return {
		frames: frames.length,
		hz: round(1000 / percentile(sorted, 0.5)),
		missed: missed.length,
		missedPct: round((missed.length / Math.max(1, frames.length)) * 100),
		droppedVsyncs: missed.reduce((sum, ms) => sum + Math.round(ms / vsyncMs) - 1, 0),
		freezes: frames.filter((ms) => ms > vsyncMs * 4).length,
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

type Device = {
	model: () => Promise<string>;
	charging: boolean;
	coolDown: () => Promise<{ status: number; ap: number; battery: number } | undefined>;
	resetFrames: () => void;
	readFrames: () => ReturnType<typeof gfxSummary> | undefined;
	fling: (page: Page, direction: "older" | "newer") => Promise<void>;
	panel: (page: Page) => Promise<void>;
	focusComposer: (page: Page) => Promise<void>;
};

function android(serial: string): Device {
	const { adb, swipe, tap } = touches(serial);
	const thermal = () => {
		const dump = adb("dumpsys", "thermalservice");
		const current = dump.slice(dump.indexOf("Current temperatures from HAL"));
		const celsius = (name: string) => Number(new RegExp(`mValue=([\\d.]+), mType=\\d+, mName=${name},`).exec(current)?.[1] ?? "NaN");
		return { status: Number(/Thermal Status: (\d+)/.exec(dump)?.[1] ?? "NaN"), ap: celsius("AP"), battery: celsius("BAT") };
	};
	return {
		model: async () => adb("getprop", "ro.product.model").trim(),
		charging: /AC powered: true|USB powered: true|Wireless powered: true/.test(adb("dumpsys", "battery")),
		coolDown: async () => {
			for (let waited = 0; ; waited += 15) {
				const now = thermal();
				if (now.status <= MAX_THERMAL_STATUS && !(now.ap > MAX_AP_CELSIUS)) return now;
				if (waited >= 900) throw new Error(`Still hot after 15 minutes: thermal status ${now.status}, AP ${now.ap}°C (limit ${MAX_AP_CELSIUS}°C, PERF_MAX_AP)`);
				console.error(`  thermal status ${now.status}, AP ${now.ap}°C, battery ${now.battery}°C: waiting`);
				await sleep(15_000);
			}
		},
		resetFrames: () => adb("dumpsys", "gfxinfo", PACKAGE, "reset"),
		readFrames: () => gfxSummary(adb("dumpsys", "gfxinfo", PACKAGE)),
		fling: async (_page, direction) => (direction === "older" ? swipe(540, 800, 540, 1900, 100) : swipe(540, 1900, 540, 800, 100)),
		panel: async (page) => {
			const { x, y } = await page.eval<{ x: number; y: number }>(`return center(button("Bot 列表"));`);
			tap(x, y);
			await sleep(1200);
			swipe(800, 1200, 50, 1200, 150);
			await sleep(1200);
		},
		focusComposer: async (page) => {
			const { x, y } = await page.eval<{ x: number; y: number }>(`return center(document.querySelector(".composer textarea"));`);
			tap(x, y);
			await sleep(1200);
		},
	};
}

const LIST = `document.querySelector(".side-popup.side-left")`;

const iphone: Device = {
	model: () => Promise.resolve("iPhone"),
	charging: false,
	coolDown: () => Promise.resolve(undefined),
	resetFrames: () => undefined,
	readFrames: () => undefined,
	fling: async (page, direction) => {
		await page.eval(`transcript().scrollBy({ top: ${direction === "older" ? -1800 : 1800}, behavior: "smooth" }); return true;`);
	},
	panel: async (page) => {
		await page.eval(`button("Bot 列表").click(); await sleep(1200); ${LIST}.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await sleep(1200); return true;`);
	},
	focusComposer: () => Promise.reject(new Error("nothing can type on the iPhone from this Mac")),
};

async function flings(page: Page, direction: "older" | "newer", count: number, gap: number) {
	for (let i = 0; i < count; i++) {
		await device.fling(page, direction);
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
			await flings(page, "older", 3, 1500);
			await flings(page, "newer", 3, 1500);
			return;
		case "stream":
			return streamAndWait(page);
		case "streamscroll":
			return streamAndWait(page, async () => {
				await sleep(1500);
				await flings(page, "older", 2, 1200);
				await flings(page, "newer", 2, 1200);
			});
		case "typing":
			for (const key of "abcdefghijklmnopqrstuvwxyzabcd") {
				await page.command("Input.dispatchKeyEvent", { type: "keyDown", key, text: key });
				await page.command("Input.dispatchKeyEvent", { type: "keyUp", key });
				await sleep(TYPING_GAP_MS);
			}
			await sleep(500);
			return;
		case "panel":
			for (let i = 0; i < 3; i++) await device.panel(page);
			return;
	}
}

async function prepare(page: Page, scene: Scene) {
	await page.eval(`await until(() => window.piController && !busy(), 60000); document.activeElement?.blur(); transcript().scrollTop = 1e9; await sleep(800); return true;`);
	if (!(await page.eval<boolean>(`return ${LIST}.inert;`))) throw new Error("The Bot list is open: close it, or the scene measures the list instead of the conversation");
	if (scene === "typing") await device.focusComposer(page);
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
	const heat = await device.coolDown();
	device.resetFrames();
	await page.eval(START_RECORDING);
	await act(page, scene);
	const result = await page.eval<PageResult>(STOP_RECORDING);
	const gfx = device.readFrames();
	await finish(page, scene);
	const eventMs = ascending(result.events.map((event) => event.ms));
	return {
		heat,
		nodes: result.nodes,
		gfx,
		raf: frameSummary(result.frames, vsyncMs),
		loaf: {
			count: result.loaf.length,
			blockingMs: result.loaf.reduce((sum, entry) => sum + entry.blocking, 0),
			worst: [...result.loaf].sort((a, b) => b.ms - a.ms).slice(0, 3),
		},
		input: {
			slow: result.events.length,
			p95: percentile(eventMs, 0.95),
			processingP95: percentile(ascending(result.events.map((event) => event.processing)), 0.95),
			worst: [...result.events].sort((a, b) => b.ms - a.ms).slice(0, 3),
		},
	};
}

type Sample = Awaited<ReturnType<typeof measure>>;

const device = ios ? iphone : android(serial);
const page = await Page.connect(port);
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
if (!ios && checked.rafHz < 110) throw new Error(`The page runs at ${checked.rafHz} Hz, not 120: set 動態流暢度 to 自適應 or 高 and keep the screen on.`);
if (ios && checked.rafHz < 55) throw new Error(`The page runs at ${checked.rafHz} Hz: keep the iPhone unlocked with pi in front, and Low Power Mode off.`);
const vsyncMs = 1000 / (checked.rafHz >= 90 ? 120 : 60);

const charging = device.charging;
if (charging) console.error("The phone is charging: it runs warmer and may throttle. Unplug it for numbers you will compare.");
mkdirSync("test/perf/out", { recursive: true });
const file = `test/perf/out/${label}.json`;
const report = { label, at: new Date().toISOString(), device: await device.model(), charging, bot: checked.bot, rafHz: checked.rafHz, runs, scenes: {} as Record<string, { median: Record<string, number>; runs: Sample[] }> };
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
			...(ios
				? {}
				: {
						gfxFrames: median((s) => s.gfx?.frames ?? 0),
						gfxJankyPct: median((s) => s.gfx?.jankyPct ?? 0),
						gfxOver12ms: median((s) => s.gfx?.over12ms ?? 0),
						gfxOver33ms: median((s) => s.gfx?.over33ms ?? 0),
						gfxP90: median((s) => s.gfx?.p90 ?? 0),
						gfxP99: median((s) => s.gfx?.p99 ?? 0),
						gpuP99: median((s) => s.gfx?.gpuP99 ?? 0),
					}),
			rafFrames: median((s) => s.raf.frames),
			rafMissedPct: median((s) => s.raf.missedPct),
			rafDroppedVsyncs: median((s) => s.raf.droppedVsyncs),
			rafFreezes: median((s) => s.raf.freezes),
			rafP99: median((s) => s.raf.p99),
			...(ios
				? {}
				: {
						loafBlockingMs: median((s) => s.loaf.blockingMs),
						inputP95: median((s) => s.input.p95),
						inputProcessingP95: median((s) => s.input.processingP95),
					}),
		},
		runs: samples,
	};
	writeFileSync(file, `${JSON.stringify(report, null, "\t")}\n`);
}
page.close();

const rows = Object.entries(report.scenes).map(([scene, { median }]) => ({ scene, ...median }));
const baseline = option("compare", "");
if (baseline) {
	const before = JSON.parse(readFileSync(baseline, "utf8")) as typeof report;
	console.table(rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, before.scenes[row.scene]?.median[key] === undefined ? value : `${before.scenes[row.scene]?.median[key]} → ${value}`]))));
} else {
	console.table(rows);
}
console.log(file);
