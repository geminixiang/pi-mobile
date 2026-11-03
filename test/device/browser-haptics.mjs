import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const port = process.env.CDP_PORT ?? "9333";
const serial = process.env.ANDROID_SERIAL;
if (!serial) throw new Error("Set ANDROID_SERIAL: the pulls are real touches (adb input swipe), since the browser follows the finger through touch events");
const adb = process.env.ADB ?? `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const input = (...args) => execFileSync(adb, ["-s", serial, "shell", "input", ...args.map(String)]);
const SETTLE_MS = 900;

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const target = targets.find((candidate) => candidate.type === "page" && URL.canParse(candidate.url) && new URL(candidate.url).hostname === "localhost");
if (!target) throw new Error("No pi page on this DevTools port");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
	socket.onopen = resolve;
	socket.onerror = reject;
});
let next = 0;
const pending = new Map();
socket.onmessage = (event) => {
	const reply = JSON.parse(String(event.data));
	pending.get(reply.id)?.(reply);
	pending.delete(reply.id);
};
const evaluate = (expression) =>
	new Promise((resolve, reject) => {
		const id = ++next;
		pending.set(id, (reply) => (reply.error || reply.result.exceptionDetails ? reject(new Error(JSON.stringify(reply.error ?? reply.result.exceptionDetails))) : resolve(reply.result.result.value)));
		socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: `(async () => (${expression}))()`, awaitPromise: true, returnByValue: true } }));
	});

if (!(await evaluate(`Boolean(window.Capacitor?.isPluginAvailable("Browser") && document.querySelector(".browser-sheet"))`))) throw new Error("Open a Bot in pi first: the browser sheet belongs to the open Bot");
await evaluate(`(() => {
	const bridge = window.Capacitor;
	window.__browserHaptics = [];
	if (!bridge.__browserHapticsWatched) {
		const toNative = bridge.toNative.bind(bridge);
		bridge.toNative = (plugin, method, options, callback) => {
			if (plugin === "System" && method === "haptic") window.__browserHaptics.push(options.kind);
			return toNative(plugin, method, options, callback);
		};
		bridge.__browserHapticsWatched = true;
	}
	return true;
})()`);
const haptics = async () => (await evaluate(`window.__browserHaptics.splice(0)`)).join(",");
const isOpen = () => evaluate(`!document.querySelector(".browser-sheet").inert`);
const dpr = await evaluate("devicePixelRatio");
const height = await evaluate("innerHeight");
const center = (selector) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const px = (css) => Math.round(css * dpr);
const drag = async (selector, dy, ms = 450) => {
	const { x, y } = await center(selector);
	input("swipe", px(x), px(y), px(x), px(y + dy), ms);
	await sleep(SETTLE_MS);
};
const tap = async (selector) => {
	const { x, y } = await center(selector);
	input("tap", px(x), px(y));
	await sleep(SETTLE_MS);
};
const closed = async () => {
	if (await isOpen()) await tap(".browser-grip");
	await haptics();
};

const results = [];
const failures = [];
const expect = async (scenario, haptic, open) => {
	const seen = { haptic: await haptics(), open: await isOpen() };
	const line = `${scenario}: ${seen.haptic || "no haptic"}, browser ${seen.open ? "open" : "closed"}`;
	results.push(line);
	if (seen.haptic !== haptic || seen.open !== open) failures.push(`${line} (expected ${haptic || "no haptic"}, ${open ? "open" : "closed"})`);
};

try {
	await evaluate(`document.querySelector(".side-shield")?.click() ?? true`);
	await closed();

	await drag(".bar-what", height * 0.6);
	await expect("pull down from the header", "press", true);
	await drag(".browser-sheet-bar", -height * 0.6);
	await expect("push the top bar up", "tick", false);

	await drag(".bar-what", height * 0.6);
	await haptics();
	await drag(".browser-grip", -height * 0.6);
	await expect("push the grip up", "tick", false);

	await drag(".bar-what", 40, 300);
	await expect("a short pull that does not open it", "", false);
	await closed();

	await tap('button[aria-label="瀏覽器"]');
	await expect("tap 瀏覽器", "", true);
	await tap(".browser-grip");
	await expect("tap the grip", "", false);
} finally {
	await closed();
	socket.close();
}

for (const line of results) console.log(line);
if (failures.length > 0) {
	console.error(`FAIL:\n- ${failures.join("\n- ")}`);
	process.exit(1);
}
console.log("PASS: pulling the browser open buzzes press and pushing it shut buzzes tick, while a pull that does not take and the buttons stay silent");
