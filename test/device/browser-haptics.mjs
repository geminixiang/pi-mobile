import { setTimeout as sleep } from "node:timers/promises";
import { Page, touches } from "./page.ts";

const serial = process.env.ANDROID_SERIAL;
if (!serial) throw new Error("Set ANDROID_SERIAL: the pulls are real touches (adb input swipe), since the browser follows the finger through touch events");
const touch = touches(serial);
const SETTLE_MS = 900;
const page = await Page.connect();
const evaluate = (expression) => page.eval(`return (${expression});`);

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
const at = (selector) => evaluate(`center(document.querySelector(${JSON.stringify(selector)}))`);
const drag = async (selector, dy, ms = 450) => {
	const { x, y } = await at(selector);
	touch.swipe(x, y, x, y + Math.round(dy * dpr), ms);
	await sleep(SETTLE_MS);
};
const tap = async (selector) => {
	const { x, y } = await at(selector);
	touch.tap(x, y);
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
	page.close();
}

for (const line of results) console.log(line);
if (failures.length > 0) {
	console.error(`FAIL:\n- ${failures.join("\n- ")}`);
	process.exit(1);
}
console.log("PASS: pulling the browser open buzzes press and pushing it shut buzzes tick, while a pull that does not take and the buttons stay silent");
