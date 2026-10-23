import { type CodemodeRemoteMessage, type CodemodeRemoteReply, type CodemodeRemoteRequest, serveCodemodeRemote } from "@earendil-works/pi-codemode/portable";
import wasmUrl from "quickjs-wasi/quickjs.wasm?url";

const MAX_INTERRUPT_BUDGET = 1_000_000;

export type ToWorker = { type: "execute"; run: number; request: CodemodeRemoteRequest } | { type: "reply"; id: number; reply: CodemodeRemoteReply };
export type FromWorker = { type: "exchange"; run: number; id: number; messages: CodemodeRemoteMessage[] } | { type: "finished"; run: number };

const wasm = fetch(wasmUrl)
	.then((response) => response.arrayBuffer())
	.then((bytes) => WebAssembly.compile(bytes));

const pending = new Map<number, (reply: CodemodeRemoteReply) => void>();
let nextExchange = 0;
const post = (message: FromWorker) => postMessage(message);

addEventListener("message", (event: MessageEvent<ToWorker>) => {
	const message = event.data;
	if (message.type === "reply") {
		pending.get(message.id)?.(message.reply);
		pending.delete(message.id);
		return;
	}
	const { run, request } = message;
	void serveCodemodeRemote(
		request,
		(messages) =>
			new Promise((resolve) => {
				const id = ++nextExchange;
				pending.set(id, resolve);
				post({ type: "exchange", run, id, messages });
			}),
		{ wasm, maxInterruptBudget: MAX_INTERRUPT_BUDGET },
	).then(() => post({ type: "finished", run }));
});
