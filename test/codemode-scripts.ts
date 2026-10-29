import assert from "node:assert/strict";
import { returnLast, withSilenceHint } from "../src/agent/codemode.ts";

assert.equal(returnLast("await tools.weather({ place: \"台北\" })"), "return await tools.weather({ place: \"台北\" })");
assert.equal(returnLast("const r = await tools.health({ metric: \"steps\" })\nr"), "const r = await tools.health({ metric: \"steps\" })\nreturn r");
assert.equal(returnLast("const r = await tools.device_info()"), "const r = await tools.device_info()\nreturn r");
const parallel = "const [a, b] = await Promise.all([tools.a(), tools.b()])";
assert.equal(returnLast(parallel), parallel);
const spread = "const results = await Promise.all([\n  tools.a(),\n  tools.b(),\n])";
assert.equal(returnLast(spread), `${spread}\nreturn results`);
assert.equal(returnLast(" await tools.a()\n .then((x) => x.id)"), " return await tools.a()\n .then((x) => x.id)");
for (const kept of ["return await tools.a()", "if (x) {\n  y()\n}", "await tools.a(", "// @options: {\"timeout_ms\": 1000}\nreturn 1", "for (const x of xs) text(x)"]) assert.equal(returnLast(kept), kept);
assert.equal(returnLast("// @options: {\"timeout_ms\": 1000}\nawait tools.a()"), "// @options: {\"timeout_ms\": 1000}\nreturn await tools.a()");

const header = { type: "text" as const, text: "Script completed\nWall time 0.1 seconds\nOutput:\n" };
const silent = withSilenceHint({ output: [header] });
assert.equal(silent.output?.length, 2);
assert.match(JSON.stringify(silent.output?.[1]), /return <value>/);
const shown = { output: [header, { type: "text" as const, text: "{\"rain_chance\":0}" }] };
assert.equal(withSilenceHint(shown), shown);
const failed = { output: [{ type: "text" as const, text: "Script failed\nWall time 0.1 seconds\nOutput:\n" }], isError: true };
assert.equal(withSilenceHint(failed), failed);
console.log("codemode: a script's last expression is returned, and one that showed nothing is told to return its value");
