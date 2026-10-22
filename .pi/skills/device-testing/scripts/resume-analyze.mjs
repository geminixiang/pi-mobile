// Main-thread work around the return in a resume-trace.mjs trace: top-level tasks over a threshold (ms from the last
// visibilitychange), each with what took its time, then when the first frames were drawn.
// Usage: node resume-analyze.mjs trace.json [min ms, default 8]
import { readFileSync } from "node:fs";
const [file, minMs = "8"] = process.argv.slice(2);
const { traceEvents: ev } = JSON.parse(readFileSync(file, "utf8"));
const threads = new Map();
for (const e of ev) if (e.name === "thread_name") threads.set(`${e.pid}:${e.tid}`, e.args.name);
const main = [...threads].filter(([, n]) => n === "CrRendererMain").map(([k]) => k);
const onMain = (e) => main.includes(`${e.pid}:${e.tid}`);
const visible = ev.find((e) => onMain(e) && e.name === "EventDispatch" && e.args?.data?.type === "visibilitychange" && e.ts > 0);
const vis = ev.filter((e) => onMain(e) && e.name === "EventDispatch" && e.args?.data?.type === "visibilitychange").map((e) => e.ts);
const t0 = vis.at(-1) ?? visible?.ts ?? 0;
console.log("visibilitychange at", vis.map((t) => ((t - t0) / 1000).toFixed(0)));
const tasks = ev.filter((e) => onMain(e) && e.ph === "X" && (e.name === "ThreadControllerImpl::RunTask" || e.name === "RunTask") && e.dur >= Number(minMs) * 1000 && e.ts > t0 - 3e6);
for (const t of tasks) {
	const inner = ev.filter((e) => onMain(e) && e.ph === "X" && e.ts >= t.ts && e.ts + (e.dur ?? 0) <= t.ts + t.dur && e !== t && e.dur > 1000);
	const by = new Map();
	for (const e of inner) {
		const label = e.name === "FunctionCall" ? `FunctionCall ${e.args?.data?.functionName || "?"} ${(e.args?.data?.url || "").split("/").pop()}:${e.args?.data?.lineNumber ?? ""}` : e.name === "EventDispatch" ? `Event ${e.args?.data?.type}` : e.name === "TimerFire" ? "TimerFire" : e.name;
		by.set(label, Math.max(by.get(label) ?? 0, e.dur));
	}
	const top = [...by].sort((a, b) => b[1] - a[1]).slice(0, 7).map(([k, d]) => `${k} ${(d / 1000).toFixed(1)}`);
	console.log(`${((t.ts - t0) / 1000).toFixed(0).padStart(6)} ms  ${(t.dur / 1000).toFixed(1).padStart(6)} ms  ${top.join(" | ")}`);
}
// Frames the compositor drew after the return
const draws = ev.filter((e) => e.name === "DrawFrame" || e.name === "Graphics.Pipeline" && e.args?.step === "SubmitCompositorFrame").map((e) => e.ts).filter((t) => t > t0).sort((a, b) => a - b);
console.log("first frames after visible (ms):", draws.slice(0, 8).map((t) => ((t - t0) / 1000).toFixed(0)).join(" "));
