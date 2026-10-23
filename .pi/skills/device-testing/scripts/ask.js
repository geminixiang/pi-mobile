import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const question = process.argv[2];
if (!question) throw new Error('usage: CDP_PORT=<port> node ask.js "<question>"');
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const script = `async () => {
	const current = (await window.piRuntime.bots()).find((bot) => bot.id === window.piController.id);
	if (!current || !/^(test|tmp|測試)/i.test(current.name)) throw new Error("ask.js asks only a test bot (name starting test, tmp, or 測試); the open bot is " + (current ? current.name : "none"));
	type(${JSON.stringify(question)}); await sleep(300);
	const t0 = performance.now();
	click('送出');
	await until(() => busy(), 20000).catch(() => 0);
	while (busy()) {
		await sleep(400);
		if (performance.now() - t0 > 300000) break;
	}
	await sleep(800);
	const last = [...document.querySelectorAll('.prompt')].at(-1);
	const steps = [];
	for (let el = last.nextElementSibling; el; el = el.nextElementSibling) for (const s of el.querySelectorAll('.step')) steps.push(s.dataset.tool + ' ' + s.innerText.slice(0, 220).replace(/\\n/g, ' ⏎ '));
	return { seconds: Math.round((performance.now() - t0) / 1000), steps, answer: [...document.querySelectorAll('.answer')].at(-1)?.innerText.slice(0, 500) };
}`;
process.stdout.write(execFileSync("./test/ui.sh", [script], { cwd: repo, env: process.env, maxBuffer: 1 << 24 }).toString() + "\n");
