import assert from "node:assert/strict";
import { returnLast, withSilenceHint } from "../src/agent/codemode.ts";

assert.equal(returnLast("await tools.weather({ place: \"台北\" })"), "return await tools.weather({ place: \"台北\" })");
assert.equal(returnLast("const r = await tools.health({ metric: \"steps\" })\nr"), "const r = await tools.health({ metric: \"steps\" })\nreturn r");
assert.equal(returnLast("const r = await tools.device_info()"), "const r = await tools.device_info()\nreturn r");
assert.equal(returnLast("const r = await tools.a();text(r);"), "const r = await tools.a();return text(r);", "text() returns nothing, so what it showed is not sent again");
assert.equal(returnLast("const r = await Promise.all([tools.a()]);r.forEach(text);"), "const r = await Promise.all([tools.a()]);return r.forEach(text);");
for (const [script, rewritten] of [
	["const r = await tools.a(); r", "const r = await tools.a(); return r"],
	["const r = await tools.a(); r.rows.length", "const r = await tools.a(); return r.rows.length"],
	["const a = await tools.a(); const b = await tools.b()", "const a = await tools.a(); const b = await tools.b()\nreturn b"],
	["const out = (await tools.a()).rows.map((x) => { const y = x.close; return y })", "const out = (await tools.a()).rows.map((x) => { const y = x.close; return y })\nreturn out"],
	["const s = (await tools.a()).rows.reduce((n, x) => { n += x.v; return n }, 0)", "const s = (await tools.a()).rows.reduce((n, x) => { n += x.v; return n }, 0)\nreturn s"],
	["let total = 0; for (const x of (await tools.a()).rows) total += x.v; total", "let total = 0; for (const x of (await tools.a()).rows) total += x.v; return total"],
	["const r = await tools.a() // first; then show", "const r = await tools.a() // first; then show\nreturn r"],
	["const r = await tools.a({ q: \"a;b\" })", "const r = await tools.a({ q: \"a;b\" })\nreturn r"],
	["await tools.a({ q: 'a;b' })", "return await tools.a({ q: 'a;b' })"],
	["await tools.a(); // done", "return await tools.a(); // done"],
	["text(x); await tools.notify({ title: \"t\" })", "text(x); return await tools.notify({ title: \"t\" })"],
] as const) assert.equal(returnLast(script), rewritten, "the last statement on the line is what is returned, and nothing before it is skipped");
const parallel = "const [a, b] = await Promise.all([tools.a(), tools.b()])";
assert.equal(returnLast(parallel), parallel);
const spread = "const results = await Promise.all([\n  tools.a(),\n  tools.b(),\n])";
assert.equal(returnLast(spread), `${spread}\nreturn results`);
assert.equal(returnLast(" await tools.a()\n .then((x) => x.id)"), " return await tools.a()\n .then((x) => x.id)");
for (const kept of ["return await tools.a()", "if (x) {\n  y()\n}", "await tools.a(", "// @options: {\"timeout_ms\": 1000}\nreturn 1", "for (const x of xs) text(x)"]) assert.equal(returnLast(kept), kept);
assert.equal(returnLast("// @options: {\"timeout_ms\": 1000}\nawait tools.a()"), "// @options: {\"timeout_ms\": 1000}\nreturn await tools.a()");
assert.equal(returnLast("await tools.a();"), "return await tools.a();");
for (const later of ["text(x);return await tools.notify({ title: \"t\" });", "text(x)\n  await tools.notify({ title: \"t\" })", "text(x.replace(/\\(.*$/, \"\")); await tools.notify({ title: \"t\" })", "text(/it's/.test(x)); await tools.notify({ title: \"t\" })"]) assert.equal(returnLast(later), later);

const header = { type: "text" as const, text: "Script completed\nWall time 0.1 seconds\nOutput:\n" };
const silent = withSilenceHint({ output: [header] });
assert.equal(silent.output?.length, 2);
assert.match(JSON.stringify(silent.output?.[1]), /return <value>/);
const shown = { output: [header, { type: "text" as const, text: "{\"rain_chance\":0}" }] };
assert.equal(withSilenceHint(shown), shown);
const failed = { output: [{ type: "text" as const, text: "Script failed\nWall time 0.1 seconds\nOutput:\n" }], isError: true };
assert.equal(withSilenceHint(failed), failed);
console.log("codemode: a script's last expression is returned, and one that showed nothing is told to return its value");
