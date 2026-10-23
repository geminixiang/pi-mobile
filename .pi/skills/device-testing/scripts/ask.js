// Ask the open bot something in natural words, as a user would; print the tools it called, the answer, and the
// seconds it took.
// Usage: CDP_PORT=<port> node ask.js "<question>"
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const question = process.argv[2];
if (!question) throw new Error('usage: CDP_PORT=<port> node ask.js "<question>"');
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const script = `async () => {
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
