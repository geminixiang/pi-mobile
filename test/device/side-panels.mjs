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
	const started = await send("Runtime.evaluate", { expression: `(async () => (${expression}))()` });
	const reply = started.exceptionDetails ? started : await send("Runtime.awaitPromise", { promiseObjectId: started.result.objectId, returnByValue: true });
	if (reply.exceptionDetails || reply.wasThrown) throw new Error(JSON.stringify(reply.exceptionDetails ?? reply.result));
	return reply.result.value;
}
const webkit = await evaluate("!/Chrome/.test(navigator.userAgent)");
let touching = false;
async function touch(type, x, y) {
	const ending = type === "touchEnd" || type === "touchCancel";
	if (webkit) await evaluate(`(() => {
		const name = ${JSON.stringify(type.toLowerCase())};
		if (name === "touchstart") window.__sideTouchTarget = document.elementFromPoint(${x ?? 0}, ${y ?? 0});
		const target = window.__sideTouchTarget;
		const point = new Touch({ identifier: 1, target, clientX: ${x ?? 0}, clientY: ${y ?? 0}, pageX: ${x ?? 0}, pageY: ${y ?? 0}, screenX: ${x ?? 0}, screenY: ${y ?? 0} });
		const touches = name === "touchend" || name === "touchcancel" ? [] : [point];
		target.dispatchEvent(new TouchEvent(name, { bubbles: true, cancelable: true, composed: true, touches, targetTouches: touches, changedTouches: [point] }));
	})()`);
	else await send("Input.dispatchTouchEvent", { type, touchPoints: ending ? [] : [{ x, y, id: 1 }] });
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
		const card = document.querySelector('.app');
		return { x: card.getBoundingClientRect().x, width: element.getBoundingClientRect().width, open: element.parentElement.hasAttribute('data-open'), transform: getComputedStyle(card).transform };
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
			if (document.querySelector('.side-viewport[data-open]')) throw new Error('Close existing side panels before running');
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
		if (Math.abs(opening.x) - Math.abs(before.x) > 0.5) failures.push(`${side} overshot while opening: ${opening.x - before.x}px`);
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
		const pageWidth = await evaluate("innerWidth");
		if (pageWidth !== width) failures.push(`the page widened to ${pageWidth}px after the ${side} panel pushed the card aside`);
	}
	await touch("touchStart", 60, y);
	await touch("touchMove", 90, y);
	await sleep(50);
	const held = await snapshot("left");
	await touch("touchMove", 150, y);
	await sleep(50);
	const followed = await snapshot("left");
	await touch("touchCancel");
	await sleep(350);
	console.log(JSON.stringify({ held: held.x, followed: followed.x }));
	if (Math.abs(held.x) > 0.5) failures.push(`the card jumped ${held.x}px on the move that started the drag`);
	if (Math.abs(followed.x - 60) > 0.5) failures.push(`the card moved ${followed.x}px for 60px of drag after it started`);
	const button = await evaluate(`(async () => {
		const candidates = [...document.querySelectorAll('.transcript .step-body'), ...document.querySelectorAll('.transcript button')].filter((b) => { const r = b.getClientRects()[0]; return r && r.width > 12; });
		for (const target of candidates) {
			target.scrollIntoView({ block: 'center' });
			await new Promise((resolve) => setTimeout(resolve, 400));
			const r = target.getClientRects()[0];
			const x = target.classList.contains('step-body') ? 40 : r.left + r.width / 2;
			const y = r.top + r.height / 2;
			if (document.elementFromPoint(x, y)?.closest('button') === target) return { x, y, side: x < innerWidth / 2 ? 'left' : 'right', label: target.getAttribute('aria-label') ?? target.className };
		}
		return null;
	})()`);
	assert(button, "The conversation needs a button, such as a code block's copy button");
	await drag(button.x, button.side === "left" ? Math.min(width - 16, button.x + width * 0.6) : Math.max(16, button.x - width * 0.6), button.y);
	await touch("touchEnd");
	await sleep(350);
	const fromButton = await snapshot(button.side);
	console.log(JSON.stringify({ fromButton, button }));
	if (!fromButton.open) failures.push(`a swipe starting on ${button.label} did not open the ${button.side} panel`);
	await evaluate("document.querySelector('.side-shield')?.click()");
	await sleep(350);
	assert.equal(failures.length, 0, failures.join("; "));
	console.log("PASS: both panels stop at fully open, still swipe closed, and open from a swipe that starts on a button.");
} finally {
	try {
		if (touching) await touch("touchCancel");
	} finally {
		socket.close();
	}
}
