import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [serial, variant, rounds = "3", only = ""] = process.argv.slice(2);
if (!serial || !variant) throw new Error("usage: CDP_PORT=<port> node run.mjs <serial> <variant> [rounds] [task,task]");
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const out = fileURLToPath(new URL("./runs/", import.meta.url));
mkdirSync(out, { recursive: true });
const adb = (...args) => execFileSync(`${process.env.HOME}/Library/Android/sdk/platform-tools/adb`, ["-s", serial, ...args]).toString();
const ui = (fn) => JSON.parse(execFileSync("./test/ui.sh", [fn], { cwd: repo, env: process.env, maxBuffer: 1 << 26 }).toString());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const TASKS = [
	{ id: "calc", apps: ["com.google.android.calculator"], clear: true, ask: "用計算機 app 幫我算 (37+45)×12，畫面上顯示多少？", check: /984/ },
	{ id: "oneui", apps: ["com.android.settings"], ask: "我手機的 One UI 版本是多少？去設定裡看", check: /8\.5/ },
	{ id: "alarms", apps: ["com.sec.android.app.clockpackage"], ask: "時鐘 app 裡我設了哪些鬧鐘？哪些有開？", check: /9:15/ },
	{ id: "storage", apps: ["com.android.settings"], ask: "設定裡看一下，哪三個 app 佔最多儲存空間？", check: /7\.08/ },
	{ id: "note", apps: ["com.samsung.android.app.notes"], ask: "幫我在三星筆記新增一則筆記，標題「pi 測試」，內容寫「手機畫面操控測試，看完可刪」", check: /pi 測試/ },
];

async function run(task, round) {
	for (const app of task.apps) adb("shell", "am", "force-stop", app);
	if (task.clear) for (const app of task.apps) adb("shell", "pm", "clear", app);
	adb("shell", "am", "start", "-n", "dev.geminixiang.pimobile/.MainActivity");
	await sleep(1500);
	const id = ui(`async () => { await until(() => window.piRuntime, 20000); const r = window.piRuntime; const id = await r.createBot({ name: "tmp-bench", job: "", avatar: "" }); await r.setComputer(id, "phone"); localStorage["pi-mobile.lastBot"] = String(id); setTimeout(() => location.reload(), 50); return id; }`);
	await sleep(5000);
	ui(`async () => { await until(() => window.piController && window.piController.id === ${id}, 30000); await sleep(1500); return true; }`);
	let trace;
	try {
		trace = execFileSync("node", [".pi/skills/device-testing/scripts/trace.js", task.ask], { cwd: repo, env: process.env, maxBuffer: 1 << 26 }).toString();
	} catch (error) {
		trace = `FAILED ${error.message}\n${error.stdout ?? ""}`;
	}
	adb("shell", "am", "start", "-n", "dev.geminixiang.pimobile/.MainActivity");
	await sleep(1500);
	ui(`async () => { await window.piRuntime.removeBot(${id}); return true; }`);
	const file = `${out}${variant}-${task.id}-${round}.txt`;
	writeFileSync(file, trace);
	const summary = JSON.parse(trace.match(/^SUMMARY (.*)$/m)?.[1] ?? "{}");
	const answer = trace.match(/^ANSWER ([\s\S]*?)\nSUMMARY/m)?.[1] ?? "";
	const results = [...trace.matchAll(/^\{"result":"(read_phone_screen|use_phone_screen|codemode)".*$/gm)].map((m) => JSON.parse(m[0]));
	const row = {
		variant,
		task: task.id,
		round,
		ok: task.check.test(answer),
		seconds: summary.seconds,
		modelCalls: summary.modelCalls,
		uncachedIn: summary.uncachedIn,
		cachedIn: summary.cachedIn,
		out: summary.out,
		images: results.reduce((n, r) => n + (r.images ?? 0), 0),
		direct: results.filter((r) => r.result !== "codemode").length,
		codemode: results.filter((r) => r.result === "codemode").length,
		path: summary.path,
		answer: answer.slice(0, 160).replace(/\n/g, " "),
	};
	writeFileSync(`${out}results.jsonl`, `${JSON.stringify(row)}\n`, { flag: "a" });
	console.log(JSON.stringify(row));
}

const tasks = TASKS.filter((task) => !only || only.split(",").includes(task.id));
for (let round = 1; round <= Number(rounds); round++) for (const task of tasks) await run(task, round);
