import { setTimeout as sleep } from "node:timers/promises";
import { Page, touches } from "./page.ts";

const serial = process.env.ANDROID_SERIAL;
if (!serial) throw new Error("Set ANDROID_SERIAL: the drags are real touches (adb input swipe), since DevTools' synthesized scroll never returns on the S24");
const { input } = touches(serial);
const page = await Page.connect();
const evaluate = (expression) => page.eval(`return (${expression});`);

const SENDER = "測試效能";
const distance = () => evaluate(`(() => { const t = document.querySelector(".transcript"); return t ? Math.round(t.scrollHeight - t.scrollTop - t.clientHeight) + 0 : -999; })()`);
const contentHeight = () => evaluate(`document.querySelector(".transcript")?.scrollHeight ?? 0`);
const busy = () => evaluate("busy()");
const until = async (check, ms = 30000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await check()) return true;
		await sleep(100);
	}
	return false;
};
const stop = async () => {
	await evaluate(`button("停止")?.click() ?? true`);
	await until(async () => !(await busy()));
	await sleep(500);
};
const toBottom = () => evaluate(`(() => { const t = document.querySelector(".transcript"); t.scrollTop = t.scrollHeight; return true; })()`);
const streaming = () => until(() => evaluate(`Boolean(document.querySelector(".transcript .answer .streaming, .transcript article.answer:last-of-type")) && Boolean(button("停止"))`), 20000).then(() => sleep(600));
const sendFromComposer = async (text) => {
	await evaluate(`(() => { const area = document.querySelector(".composer textarea"); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(area, ${JSON.stringify(text)}); area.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
	await sleep(150);
	await evaluate(`button("送出").click() ?? true`);
};
let prompts = 0;
const prompt = () => `stream ${++prompts}`;
const sendFromElsewhere = (text) => evaluate(`window.piController.send([{ type: "text", text: ${JSON.stringify(text)} }]).then(() => true)`);
let scale = 1;
const gesture = async (pixels) => {
	const { x, y, dpr } = await evaluate(`(() => { const r = document.querySelector(".transcript").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * 0.4, dpr: devicePixelRatio }; })()`);
	const at = (css) => String(Math.round(css * dpr));
	input("swipe", at(x), at(y), at(x), at(y + pixels), "700");
	await sleep(300);
};
const scrollUp = (pixels) => gesture(Math.round(pixels / scale));
const follows = async () => {
	const gaps = [];
	for (let i = 0; i < 5; i++) {
		await sleep(200);
		gaps.push(await distance());
	}
	return { gaps: gaps.join(", "), following: gaps.filter((gap) => gap > -4 && gap < 4).length >= 2 };
};
const results = [];
const failures = [];
const record = (scenario, seen, ok) => {
	results.push(`${scenario}: ${seen}`);
	if (!ok) failures.push(`${scenario}: ${seen}`);
};

const sender = await evaluate(`(async () => (await window.piRuntime.bots()).find((bot) => bot.name === ${JSON.stringify(SENDER)})?.id ?? null)()`);
if (sender === null) throw new Error(`Run test/perf/fixture.ts setup first: the ${SENDER} bot streams from the fake model, so no real model is called`);
if ((await evaluate("window.piController?.id")) !== sender) {
	await evaluate(`[...document.querySelectorAll(".drawer-open")].find((item) => item.textContent.includes(${JSON.stringify(SENDER)})).click() ?? true`);
	await until(() => evaluate(`window.piController?.id === ${sender} && Boolean(document.querySelector(".composer textarea"))`));
}
await evaluate("document.activeElement?.blur() ?? true");
if (await busy()) await stop();

try {
	await toBottom();
	await sleep(300);
	await gesture(100);
	await sleep(400);
	scale = (await distance()) / 100;
	results.push(`scroll gesture scale: ${scale}`);
	if (scale <= 0) throw new Error("A 100px drag up did not move the transcript; is pi in front with the 測試效能 Bot open?");
	for (const pixels of [20, 40, 80]) {
		await toBottom();
		await sendFromComposer(prompt());
		await streaming();
		await sleep(800);
		await scrollUp(pixels);
		const left = await distance();
		await sleep(1500);
		const later = await distance();
		record(`(a) 串流中往上捲 ${pixels}px`, `離底 ${left} → 1.5 秒後 ${later}`, later >= 4);
		await stop();
	}

	await toBottom();
	await sendFromComposer(prompt());
	await streaming();
	const bottom = await follows();
	record("(b) 在底部時串流", `每 0.2 秒離底 ${bottom.gaps}`, bottom.following);
	await stop();

	await sleep(2000);
	await toBottom();
	await sleep(500);
	await scrollUp(30);
	await sleep(500);
	const parked = await distance();
	const grownFrom = await contentHeight();
	await sendFromElsewhere(prompt());
	await streaming();
	await sleep(1500);
	const pulled = await distance();
	const grew = (await contentHeight()) - grownFrom;
	record("(c) 離底 30px 停住，別處開始串流", `離底 ${parked} → 1.5 秒後 ${pulled}（內容長了 ${grew}px）`, grew > 0 && pulled >= parked);
	await stop();

	await toBottom();
	await sendFromComposer(prompt());
	await streaming();
	await sleep(600);
	await scrollUp(300);
	await sleep(400);
	const away = await distance();
	await evaluate(`document.querySelector(".scroll-hint:not(.ghost)")?.click() ?? true`);
	await sleep(1000);
	const latest = await follows();
	record("(d) 串流中按回到最新", `離底 ${away} → 按下 1 秒後每 0.2 秒 ${latest.gaps}`, latest.following);
	await stop();

	await toBottom();
	await sleep(300);
	await scrollUp(300);
	await sleep(400);
	const before = await distance();
	await sendFromComposer(prompt());
	await streaming();
	const sent = await follows();
	record("(d) 離底時送出", `離底 ${before} → 送出後串流中每 0.2 秒 ${sent.gaps}`, sent.following);
	await stop();

	await toBottom();
	await sleep(300);
	const { x, y } = await evaluate(`(() => { const r = document.querySelector(".composer textarea").getBoundingClientRect(); return { x: Math.round((r.left + r.width / 2) * devicePixelRatio), y: Math.round((r.top + r.height / 2) * devicePixelRatio) }; })()`);
	const height = () => evaluate(`document.querySelector(".transcript").clientHeight`);
	const open = await height();
	input("tap", String(x), String(y));
	await sleep(1500);
	const typing = await height();
	const withKeyboard = await distance();
	if (typing < open) {
		input("keyevent", "KEYCODE_BACK");
		await sleep(1500);
		const closed = await distance();
		record("(e) 在底部開關鍵盤", `對話區高 ${open} → ${typing}；開著離底 ${withKeyboard}，關掉後離底 ${closed}`, withKeyboard < 4 && closed < 4);
	} else results.push(`(e) skipped: tapping the composer did not open a keyboard (對話區高 ${open} → ${typing})`);
	await evaluate("document.activeElement?.blur() ?? true");
} finally {
	if (await busy()) await stop();
	page.close();
}

for (const line of results) console.log(line);
if (failures.length > 0) {
	console.error(`FAIL:\n- ${failures.join("\n- ")}`);
	process.exit(1);
}
console.log("PASS: a small drag up while streaming lets go and stays, the bottom keeps following, a parked view is not pulled back, and 回到最新, sending and the keyboard keep it at the bottom");
