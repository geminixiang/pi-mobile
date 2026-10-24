import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

const port = process.env.CDP_PORT ?? "9333";
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page");
if (!page) throw new Error("No WebView page target");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let next = 0;
const pending = new Map();
socket.onmessage = (event) => {
	const reply = JSON.parse(String(event.data));
	const call = pending.get(reply.id);
	if (!call) return;
	pending.delete(reply.id);
	if (reply.error) call.reject(new Error(JSON.stringify(reply.error)));
	else call.resolve(reply.result);
};
socket.onclose = () => {
	for (const call of pending.values()) call.reject(new Error("WebView disconnected"));
	pending.clear();
};
function send(method, params) {
	const id = ++next;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`${method} timed out`));
		}, 10000);
		pending.set(id, {
			resolve: (value) => { clearTimeout(timer); resolve(value); },
			reject: (error) => { clearTimeout(timer); reject(error); },
		});
		socket.send(JSON.stringify({ id, method, params }));
	});
}
async function evaluate(expression) {
	const reply = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails));
	return reply.result.value;
}
let touching = false;
async function touch(type, x, y) {
	const ending = type === "touchEnd" || type === "touchCancel";
	await send("Input.dispatchTouchEvent", { type, touchPoints: ending ? [] : [{ x, y, id: 1 }] });
	touching = !ending;
}
async function drag(x1, x2, y) {
	await touch("touchStart", x1, y);
	await move(x1, x2, y);
}
async function move(x1, x2, y) {
	for (let i = 1; i <= 12; i++) {
		await touch("touchMove", x1 + (x2 - x1) * i / 12, y);
		await sleep(12);
	}
}
async function snapshot(side) {
	return evaluate(`(() => {
		const element = document.querySelector('.side-${side}');
		const rect = element.getBoundingClientRect();
		return { x: rect.x, width: rect.width, open: element.hasAttribute('data-open'), movement: element.style.getPropertyValue('--drawer-swipe-movement-x'), inlineTransform: element.style.transform, transform: getComputedStyle(element).transform };
	})()`);
}
const failures = [];
try {
	const bot = await evaluate("(async () => (await window.piRuntime.bots()).find(bot => bot.id === window.piController?.id))()");
	assert(bot && /^(test|tmp|測試)/i.test(bot.name), "Open a test bot before running side panel gestures");
	const { width, height } = await evaluate("({width: innerWidth, height: innerHeight})");
	const y = height * 0.6;
	for (const side of ["left", "right"]) {
		assert.equal(await evaluate("window.piController?.id"), bot.id, "The selected bot changed during the test");
		const label = side === "left" ? "Bot 列表" : "Bot 資訊";
		await evaluate(`(() => {
			if ([...document.querySelectorAll('.side-popup')].some(e => e.hasAttribute('data-open'))) throw new Error('Close existing side panels before running');
			const button = document.querySelector('button[aria-label="${label}"]');
			if (!button) throw new Error('Missing ${label} button');
			button.click();
		})()`);
		await sleep(350);
		const before = await snapshot(side);
		assert(before.open, `${side} must open`);
		const start = side === "left" ? 100 : width - 100;
		const end = side === "left" ? width - 24 : 24;
		await drag(start, end, y);
		const during = await snapshot(side);
		console.log(JSON.stringify({ side, before, during }));
		if (Math.abs(during.x - before.x) > 0.5 || Math.abs(during.width - before.width) > 0.5) failures.push(`${side} moved beyond fully open: ${during.x - before.x}px`);
		await touch("touchEnd");
		await sleep(350);
		assert((await snapshot(side)).open, `${side} must stay open after outward drag`);
		await drag(side === "left" ? before.width - 24 : width - before.width + 24, side === "left" ? 16 : width - 16, y);
		await touch("touchEnd");
		await sleep(350);
		assert(!(await snapshot(side)).open, `${side} must still swipe closed`);
		const openingStart = side === "left" ? 16 : width - 16;
		const openingEnd = side === "left" ? width - 16 : 16;
		await drag(openingStart, openingEnd, y);
		const opening = await snapshot(side);
		console.log(JSON.stringify({ side, opening }));
		assert(opening.open, `${side} must swipe open`);
		if (Math.abs(opening.x - before.x) > 0.5) failures.push(`${side} overshot while opening: ${opening.x - before.x}px`);
		await touch("touchEnd");
		await sleep(350);
		const closingStart = side === "left" ? before.width - 24 : width - before.width + 24;
		const closingEnd = side === "left" ? 16 : width - 16;
		const middle = (closingStart + closingEnd) / 2;
		await drag(closingStart, middle, y);
		await move(middle, side === "left" ? width - 16 : 16, y);
		const reversed = await snapshot(side);
		if (Math.abs(reversed.x - before.x) > 0.5) failures.push(`${side} overshot after reversing: ${reversed.x - before.x}px`);
		await touch("touchEnd");
		await sleep(350);
		assert((await snapshot(side)).open, `${side} must remain open after reversing`);
		await drag(closingStart, closingEnd, y);
		await touch("touchEnd");
		await sleep(350);
		assert(!(await snapshot(side)).open, `${side} must close after reversing`);
	}
	assert.equal(failures.length, 0, failures.join("; "));
	console.log("PASS: both panels stop at fully open and still swipe closed.");
} finally {
	try {
		if (touching) await touch("touchCancel");
	} finally {
		socket.close();
	}
}
