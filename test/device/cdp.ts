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
type Evaluated = { result?: { objectId?: string; value?: unknown; description?: string }; exceptionDetails?: unknown; wasThrown?: boolean };
// why: the iPad's CDP bridge (pymobiledevice3) ignores awaitPromise on evaluate but supports Runtime.awaitPromise
const started = (await send("Runtime.evaluate", { expression })) as Evaluated;
const result = started.exceptionDetails ? started : ((await send("Runtime.awaitPromise", { promiseObjectId: started.result?.objectId, returnByValue: true })) as Evaluated);
console.log(JSON.stringify(result.exceptionDetails ?? (result.wasThrown ? result.result?.description : result.result?.value), null, 2));
socket.close();
