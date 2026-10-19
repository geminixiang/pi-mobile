// Drives the app's WebView over the Chrome DevTools Protocol, for on-device tests of debug builds.
// Forward the socket first: adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>
// Usage: node test/cdp.ts '<js expression to evaluate in the page>'
export {};
const port = process.env.CDP_PORT ?? "9333";
const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
const page = targets.find((target) => target.type === "page");
if (!page) throw new Error("No WebView page target");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
	socket.onopen = resolve;
	socket.onerror = reject;
});

let nextId = 0;
const pending = new Map<number, (value: unknown) => void>();
socket.onmessage = (event) => {
	const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown };
	if (message.id !== undefined) pending.get(message.id)?.(message.result);
};

function send(method: string, params: object): Promise<unknown> {
	const id = ++nextId;
	socket.send(JSON.stringify({ id, method, params }));
	return new Promise((resolve) => pending.set(id, resolve));
}

const expression = process.argv[2];
if (!expression) throw new Error("Pass an expression");
const result = (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })) as {
	result?: { value?: unknown };
	exceptionDetails?: unknown;
};
console.log(JSON.stringify(result.exceptionDetails ?? result.result?.value, null, 2));
socket.close();
