import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { patchPiEnvConnection } from "../vite-plugins/pi-env.ts";

const patched = patchPiEnvConnection(readFileSync(new URL("../node_modules/@earendil-works/pi-env/dist/connection.js", import.meta.url), "utf8"));
assert(!patched.includes(".unref()"), "pi-env's Connection still calls unref(), which the WebView's timers do not have");
console.log("pi-env patches: Connection runs on WebView timers");
