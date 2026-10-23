import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { Value } from "typebox/value";

const Outcome = Type.Object({ stdout: Type.String(), exit: Type.Number() });
type Outcome = { stdout: string; exit: number };

const port = process.env.CDP_PORT ?? "9333";
const only = process.argv[2];
const here = new URL(".", import.meta.url);
const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(name, here), "utf8"));
const cases = read<Record<string, string>>("cases.json");
const gnu = read<Record<string, Outcome>>("gnu.json");
const accepted = read<Record<string, Outcome>>("accepted.json");
const BOT = "測試bash-regression";

const targets: { type: string; webSocketDebuggerUrl: string }[] = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page");
if (!page) throw new Error(`no WebView page on port ${port}`);
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
	socket.onopen = resolve;
	socket.onerror = reject;
});
let nextId = 0;
const pending = new Map<number, (message: { result?: { result?: { value?: unknown }; exceptionDetails?: unknown } }) => void>();
socket.onmessage = (event) => {
	const message = JSON.parse(String(event.data));
	if (typeof message.id === "number") pending.get(message.id)?.(message);
};
async function evaluate(expression: string): Promise<unknown> {
	const id = ++nextId;
	socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
	const message = await new Promise<{ result?: { result?: { value?: unknown }; exceptionDetails?: unknown } }>((resolve) => pending.set(id, resolve));
	if (message.result?.exceptionDetails) throw new Error(JSON.stringify(message.result.exceptionDetails).slice(0, 400));
	return message.result?.result?.value;
}

await evaluate(`(async () => {
	const rt = window.piRuntime;
	const id = await rt.createBot({ name: ${JSON.stringify(BOT)}, job: "", avatar: "coder" });
	await rt.setComputer(id, "phone");
	window.__bashRegression = { id, env: rt.phoneFolder(id) };
})()`);

const regressions: string[] = [];
const fixed: string[] = [];
let matchesGnu = 0;
let acceptedGaps = 0;
for (const [name, body] of Object.entries(cases)) {
	if (only && !name.includes(only)) continue;
	const outcome = Value.Parse(Outcome, await evaluate(`(async () => {
		const env = window.__bashRegression.env;
		await env.exec("mkdir -p /jbt/${name}", {}, {});
		let stdout = "";
		const result = await env.exec(${JSON.stringify(body)}, { cwd: "/jbt/${name}", timeout: 60, onOutput: (text, _context, info) => { if (info.stream === "stdout") stdout += text; } }, {});
		return { stdout, exit: result.ok ? result.value.exitCode : -1 };
	})()`));
	const same = (expected: Outcome | undefined) => expected !== undefined && expected.stdout === outcome.stdout && expected.exit === outcome.exit;
	if (same(gnu[name])) {
		matchesGnu += 1;
		if (accepted[name]) fixed.push(name);
	} else if (same(accepted[name])) {
		acceptedGaps += 1;
	} else {
		regressions.push(name);
	}
}

await evaluate(`window.piRuntime.removeBot(window.__bashRegression.id)`);
socket.close();
console.log(`bash: ${matchesGnu} match GNU, ${acceptedGaps} known gaps (accepted.json), ${regressions.length} regressions`);
if (fixed.length > 0) console.log(`now match GNU, drop from accepted.json: ${fixed.join(" ")}`);
if (regressions.length > 0) {
	console.log(`regressions: ${regressions.join(" ")}`);
	process.exit(1);
}
