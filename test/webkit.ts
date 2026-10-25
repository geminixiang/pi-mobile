import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const Pages = Type.Array(Type.Object({ url: Type.String(), webSocketDebuggerUrl: Type.String() }));
const Created = Type.Object({ method: Type.Literal("Target.targetCreated"), params: Type.Object({ targetInfo: Type.Object({ targetId: Type.String(), type: Type.String() }) }) });
const FromTarget = Type.Object({ method: Type.Literal("Target.dispatchMessageFromTarget"), params: Type.Object({ message: Type.String() }) });
const Reply = Type.Object({
	id: Type.Number(),
	result: Type.Optional(
		Type.Object({
			result: Type.Optional(Type.Object({ objectId: Type.Optional(Type.String()), value: Type.Optional(Type.Unknown()), description: Type.Optional(Type.String()) })),
			wasThrown: Type.Optional(Type.Boolean()),
		}),
	),
});

const expression = process.argv[2];
if (!expression) throw new Error("Pass an expression");
const pages = Value.Parse(Pages, await (await fetch(`http://127.0.0.1:${process.env.WEBKIT_PORT ?? "9222"}/json`)).json());
const page = pages.find((candidate) => candidate.url.startsWith("capacitor://"));
if (!page) throw new Error("No pi mobile page: is the app open in the simulator and ios_webkit_debug_proxy running?");

const socket = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map<number, (reply: Static<typeof Reply>) => void>();
let target = "";
let nextId = 0;
const ready = new Promise<void>((resolve, reject) => {
	socket.onerror = reject;
	socket.onmessage = (event) => {
		const message: unknown = JSON.parse(String(event.data));
		if (Value.Check(Created, message) && message.params.targetInfo.type === "page") {
			target = message.params.targetInfo.targetId;
			resolve();
		}
		if (!Value.Check(FromTarget, message)) return;
		const reply: unknown = JSON.parse(message.params.message);
		if (Value.Check(Reply, reply)) pending.get(reply.id)?.(reply);
	};
});
await ready;

function send(method: string, params: object) {
	const id = ++nextId;
	socket.send(JSON.stringify({ id, method: "Target.sendMessageToTarget", params: { targetId: target, message: JSON.stringify({ id, method, params }) } }));
	return new Promise<Static<typeof Reply>>((resolve) => pending.set(id, resolve));
}

const started = await send("Runtime.evaluate", { expression });
const promise = started.result?.result?.objectId;
if (started.result?.wasThrown || !promise) throw new Error(started.result?.result?.description ?? "evaluation failed");
const settled = await send("Runtime.awaitPromise", { promiseObjectId: promise, returnByValue: true });
console.log(JSON.stringify(settled.result?.wasThrown ? settled.result.result?.description : settled.result?.result?.value, null, 2));
socket.close();
