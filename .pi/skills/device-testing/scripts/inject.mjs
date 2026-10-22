// Evaluate files in the app's page, in order, as one script, and print the value of the last one. For probes that
// need a library the app does not ship: bundle it first, e.g.
//   npx esbuild entry.ts --bundle --format=iife --platform=browser --outfile=/tmp/lib.js
// where entry.ts puts what the probe needs on globalThis. Add --gesture to run with a user gesture (file and save
// pickers, Contact Picker, and other APIs that require one).
// Usage: node inject.mjs <port> [--gesture] <file.js> [more.js ...]
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const port = args.shift();
const userGesture = args[0] === "--gesture" ? Boolean(args.shift()) : false;
if (!port || args.length === 0) throw new Error("usage: node inject.mjs <port> [--gesture] <file.js> [more.js ...]");
const expression = args.map((file) => readFileSync(file, "utf8")).join("\n;\n");
const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws = new WebSocket(pages.find((page) => page.type === "page").webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener("open", resolve));
ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true, userGesture } }));
ws.addEventListener("message", (event) => {
	const message = JSON.parse(event.data);
	if (message.id !== 1) return;
	const result = message.result;
	console.log(JSON.stringify(result?.exceptionDetails ? { error: result.exceptionDetails.exception?.description ?? result.exceptionDetails.text } : result?.result?.value, null, 1));
	process.exit(0);
});
