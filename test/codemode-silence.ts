import assert from "node:assert/strict";
import { withSilenceHint } from "../src/agent/codemode.ts";

const header = { type: "text" as const, text: "Script completed\nWall time 0.1 seconds\nOutput:\n" };
const silent = withSilenceHint({ output: [header] });
assert.equal(silent.output?.length, 2);
assert.match(JSON.stringify(silent.output?.[1]), /return <value>/);
const shown = { output: [header, { type: "text" as const, text: "{\"rain_chance\":0}" }] };
assert.equal(withSilenceHint(shown), shown);
const failed = { output: [{ type: "text" as const, text: "Script failed\nWall time 0.1 seconds\nOutput:\n" }], isError: true };
assert.equal(withSilenceHint(failed), failed);
console.log("codemode: a script that showed nothing is told to return its value");
