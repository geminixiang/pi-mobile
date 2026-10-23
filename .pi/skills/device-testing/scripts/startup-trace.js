const port = process.argv[2];
if (!port) throw new Error("usage: node startup-trace.js <port> [--log]");
const listCalls = process.argv.includes("--log");
const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws = new WebSocket(pages.find((page) => page.type === "page").webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener("open", resolve));
let nextId = 0;
const pending = new Map();
ws.addEventListener("message", (event) => {
	const message = JSON.parse(event.data);
	if (message.id && pending.has(message.id)) {
		pending.get(message.id)(message.result);
		pending.delete(message.id);
	}
});
const send = (method, params = {}) =>
	new Promise((resolve) => {
		const id = ++nextId;
		pending.set(id, resolve);
		ws.send(JSON.stringify({ id, method, params }));
	});
const hook = `(() => {
	const stats = (window.__startup = { calls: [], inFlight: 0, maxConcurrent: 0 });
	const poll = () => {
		const cap = window.Capacitor;
		if (cap && typeof cap.nativePromise === "function" && !cap.nativePromise.__wrapped) {
			const original = cap.nativePromise.bind(cap);
			const wrapped = (plugin, method, options) => {
				const at = performance.now();
				stats.inFlight++;
				stats.maxConcurrent = Math.max(stats.maxConcurrent, stats.inFlight);
				const done = (result) => {
					stats.inFlight--;
					stats.calls.push({ plugin, method, at: Math.round(at), ms: Math.round(performance.now() - at), sql: String(options?.statement ?? "").replace(/\\s+/g, " ").slice(0, 100), bytes: JSON.stringify(result ?? "").length });
				};
				return original(plugin, method, options).then((result) => { done(result); return result; }, (error) => { done(); throw error; });
			};
			wrapped.__wrapped = true;
			cap.nativePromise = wrapped;
		}
		if (performance.now() < 10000) setTimeout(poll, 0);
	};
	poll();
})();`;
await send("Page.enable");
await send("Runtime.enable");
const { identifier } = await send("Page.addScriptToEvaluateOnNewDocument", { source: hook });
await send("Page.reload");
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;
let shown;
for (let i = 0; i < 300 && !shown; i++) {
	await new Promise((resolve) => setTimeout(resolve, 50));
	shown = await evaluate(`(() => { const n = document.querySelectorAll('.transcript > *').length; return n > 0 && window.piController ? { at: Math.round(performance.now()), messages: n } : null; })()`).catch(() => null);
}
await new Promise((resolve) => setTimeout(resolve, 1500));
const stats = await evaluate("window.__startup");
await send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
const before = (stats?.calls ?? []).filter((call) => !shown || call.at <= shown.at);
const byMethod = {};
for (const call of before) {
	const key = `${call.plugin}.${call.method}`;
	byMethod[key] ??= { calls: 0, waitedMs: 0 };
	byMethod[key].calls++;
	byMethod[key].waitedMs += call.ms;
}
console.log(JSON.stringify({ transcriptShownMs: shown?.at, messages: shown?.messages, nativeCallsBeforeShown: before.length, maxConcurrent: stats?.maxConcurrent, byMethod }, null, 1));
if (listCalls) for (const call of stats?.calls ?? []) console.log(`${String(call.at).padStart(6)} ${String(call.ms).padStart(5)} ms ${String(call.bytes).padStart(8)} B  ${call.plugin}.${call.method} ${call.sql}`);
process.exit(0);
