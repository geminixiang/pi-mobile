import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { keepPiInFront } from "./keep-front.js";
import { fileURLToPath } from "node:url";

const question = process.argv[2];
const image = process.argv.includes("--image");
const script = `async () => {
	const current = (await window.piRuntime.bots()).find((bot) => bot.id === window.piController.id);
	if (!current || !/^(test|tmp|測試)/i.test(current.name)) throw new Error("trace.js asks only a test bot (name starting test, tmp, or 測試); the open bot is " + (current ? current.name : "none"));
	let view; const stop = window.piController.subscribe((v) => (view = v)); await sleep(300);
	const from = view.entries.length;
	${image ? `{
		const c = document.createElement("canvas"); c.width = 600; c.height = 820; const g = c.getContext("2d");
		g.fillStyle = "#fff"; g.fillRect(0, 0, 600, 820); g.fillStyle = "#111"; g.font = "bold 40px sans-serif"; g.fillText("全家便利商店", 150, 80);
		g.font = "28px sans-serif"; ["2026-10-22 12:31", "------------------------------", "御飯糰 鮪魚        35", "拿鐵 大杯          65", "茶葉蛋 x2          26", "------------------------------", "合計              126", "現金              200", "找零               74"].forEach((l, i) => g.fillText(l, 60, 160 + i * 60));
		const blob = await new Promise((r) => c.toBlob(r, "image/png"));
		const dt = new DataTransfer(); dt.items.add(new File([blob], "receipt.png", { type: "image/png" }));
		const input = document.querySelector(".composer input[type=file]"); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true }));
		await sleep(1500);
	}` : ""}
	type(${JSON.stringify(question)}); await sleep(300);
	const t0 = performance.now(); click("送出");
	await until(() => busy(), 20000).catch(() => 0);
	while (busy()) {
		await sleep(400);
		if (performance.now() - t0 > 600000) break;
	}
	await sleep(1000); stop();
	const text = (content) => (content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
	const turn = [];
	for (const e of view.entries.slice(from)) {
		for (const m of e.model ?? []) {
			if (m.role === "system") turn.push({ system: Object.entries(m.sections ?? {}).map(([k, v]) => k + ":" + JSON.stringify(v).length), toolsAdded: m.toolsAdded });
			if (m.role === "assistant") turn.push({ at: m.timestamp, call: m.model, ms: m.durationMs, in: m.usage?.input, cached: m.usage?.cacheRead, out: m.usage?.output, thinking: (m.content ?? []).filter((c) => c.type === "thinking").map((c) => (c.thinking ?? "").length).reduce((a, b) => a + b, 0), text: text(m.content).slice(0, 160), tools: (m.content ?? []).filter((c) => c.type === "toolCall").map((c) => c.name + " " + JSON.stringify(c.arguments).slice(0, 400)) });
			if (m.role === "toolResult") turn.push({ at: m.timestamp, result: m.toolName, error: m.isError || undefined, chars: text(m.content).length, images: (m.content ?? []).filter((c) => c.type === "image").length || undefined, head: text(m.content).slice(0, 200).replace(/\\n/g, " ⏎ ") });
		}
	}
	return { seconds: Math.round((performance.now() - t0) / 1000), turn, answer: [...document.querySelectorAll(".answer")].at(-1)?.innerText.slice(0, 600) };
}`;
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const release = keepPiInFront();
const out = (await promisify(execFile)("./test/device/ui.sh", [script], { cwd: repo, env: process.env, maxBuffer: 1 << 26 })).stdout;
release();
const result = JSON.parse(out);
if (!result.turn) { console.log(out.slice(0, 2000)); process.exit(1); }
console.log(`## ${result.seconds} s`);
const toolS = {};
let call;
let group = [];
const flush = () => {
	if (group.length === 0) return;
	const slowest = group.reduce((a, b) => (b[1] > a[1] ? b : a));
	toolS[slowest[0]] = Math.round((toolS[slowest[0]] ?? 0) + slowest[1] / 1000);
	group = [];
};
for (const step of result.turn) {
	if (step.system) {
		console.log(JSON.stringify({ system: `${step.system.length} sections`, toolsAdded: (step.toolsAdded ?? []).map((tool) => tool.name) }));
		continue;
	}
	if (step.call) {
		flush();
		call = step;
	}
	if (step.result && call) {
		step.toolMs = Math.max(0, step.at - call.at - (call.ms ?? 0));
		group.push([step.result, step.toolMs]);
	}
	console.log(JSON.stringify({ ...step, at: undefined }));
}
flush();
console.log("ANSWER", result.answer);
const calls = result.turn.filter((s) => s.call);
const sum = (f) => calls.reduce((n, s) => n + (f(s) ?? 0), 0);
console.log(
	"SUMMARY " +
		JSON.stringify({
			seconds: result.seconds,
			modelCalls: calls.length,
			modelS: Math.round(sum((s) => s.ms) / 1000),
			toolS,
			uncachedIn: sum((s) => s.in),
			cachedIn: sum((s) => s.cached),
			out: sum((s) => s.out),
			toolResultChars: result.turn.filter((s) => s.result).reduce((n, s) => n + s.chars, 0),
			path: calls.flatMap((s) => s.tools.map((t) => t.split(" ")[0])).join(" "),
		}),
);
