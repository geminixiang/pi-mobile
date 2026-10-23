import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const port = args.shift();
const userGesture = args[0] === "--gesture" ? Boolean(args.shift()) : false;
if (!port || args.length === 0) throw new Error("usage: node inject.js <port> [--gesture] <file.js> [more.js ...]");
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
