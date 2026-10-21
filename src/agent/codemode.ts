// Code mode on the phone: the model writes JavaScript that calls the conversation's tools as `tools.<name>(args)`,
// for computation, data shaping, and many tool calls in one step, without a sandbox host. Durable's codemode tool
// journals every result, so a script resumes after the app is killed.
//
// Durable's README uses CodemodeSandbox (Node worker threads) or InlineCodemodeSandbox (calling thread). The WebView
// has neither worker threads nor a thread that may block: an inline VM computing for seconds would freeze the UI.
// RemoteCodemodeSandbox only needs an object with `execute(request, exchange)`, so a Web Worker running
// serveCodemodeRemote (codemode-worker.ts) is the remote, and tools keep running on the main thread.
import { type CodemodeRemote, type CodemodeRemoteExchange, RemoteCodemodeSandbox } from "@earendil-works/pi-codemode/portable";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { createCodemodeTool } from "@earendil-works/pi-durable/codemode";
import type { FromWorker, ToWorker } from "./codemode-worker.ts";

const MEMORY_LIMIT_BYTES = 128 * 1024 * 1024;
const INTERRUPT_BUDGET = 1_000_000;

class WorkerRemote implements CodemodeRemote {
	#worker: Worker | undefined;
	readonly #runs = new Map<number, { exchange: CodemodeRemoteExchange; done: () => void }>();
	#nextRun = 0;

	execute(request: Parameters<CodemodeRemote["execute"]>[0], exchange: CodemodeRemoteExchange): Promise<void> {
		return new Promise((done) => {
			const run = ++this.#nextRun;
			this.#runs.set(run, { exchange, done });
			this.#post({ type: "execute", run, request });
		});
	}

	#post(message: ToWorker): void {
		this.#worker ??= this.#start();
		this.#worker.postMessage(message);
	}

	#start(): Worker {
		const worker = new Worker(new URL("./codemode-worker.ts", import.meta.url), { type: "module" });
		worker.addEventListener("message", (event: MessageEvent<FromWorker>) => {
			const message = event.data;
			const entry = this.#runs.get(message.run);
			if (!entry) return;
			if (message.type === "finished") {
				this.#runs.delete(message.run);
				entry.done();
				return;
			}
			void entry.exchange(message.messages).then((reply) => this.#post({ type: "reply", id: message.id, reply }));
		});
		// A crashed worker ends its runs without a terminal message, which the sandbox reports as a sandbox failure.
		worker.addEventListener("error", () => {
			for (const entry of this.#runs.values()) entry.done();
			this.#runs.clear();
			worker.terminate();
			if (this.#worker === worker) this.#worker = undefined;
		});
		return worker;
	}
}

/**
 * A structured output's shape, as short as the model needs to read results: field names, `?` for optional ones,
 * nested objects in braces, `[]` for arrays; types left out (they read from the names and the tool's description).
 * From the schema itself, so it cannot drift from what the tool returns.
 */
export function shapeOf(schema: unknown): string {
	if (typeof schema !== "object" || schema === null) return "";
	const items: unknown = Reflect.get(schema, "items");
	if (Reflect.get(schema, "type") === "array") return `${shapeOf(items) || "value"}[]`;
	const properties: unknown = Reflect.get(schema, "properties");
	if (typeof properties === "object" && properties !== null) {
		const required: unknown = Reflect.get(schema, "required");
		const needed = new Set(Array.isArray(required) ? required : []);
		const fields = Object.entries(properties).map(([key, inner]) => {
			const nested = shapeOf(inner);
			return `${key}${needed.has(key) ? "" : "?"}${nested ? `: ${nested}` : ""}`;
		});
		return `{ ${fields.join(", ")} }`;
	}
	// A record: TypeBox writes its values under patternProperties, JSON Schema often under additionalProperties.
	const patterns: unknown = Reflect.get(schema, "patternProperties");
	const values: unknown = typeof patterns === "object" && patterns !== null ? Object.values(patterns)[0] : Reflect.get(schema, "additionalProperties");
	if (typeof values === "object" && values !== null && Reflect.get(schema, "type") === "object") return `Record<key, ${shapeOf(values) || "value"}>`;
	return "";
}

export function createPhoneCodemode() {
	const remote = new WorkerRemote();
	const sandbox = new RemoteCodemodeSandbox({
		remote: () => remote,
		interruptBudget: INTERRUPT_BUDGET,
		memoryLimitBytes: MEMORY_LIMIT_BYTES,
	});
	// Scripts call the conversation's tools only; models.* (classifiers, image generation) stays off for now.
	// Durable's own section lists every tool's description and TypeScript declaration again (12k characters here), all
	// of which the model already has from the tool definitions; this short note replaces it.
	return [
		defineExtension({
			name: "codemode",
			tools: [createCodemodeTool({ sandbox, models: false })],
			sections: [
				section("codemode", (input) => {
					// Gateways may rename tools for the model (such as `mcp__x__y_get_location`); scripts need the real names.
					const callable = input.agent.callable.filter((tool) => tool.name !== "codemode");
					const structured = callable.filter((tool) => tool.structuredOutputSchema).map((tool) => `${tool.name}: ${shapeOf(tool.structuredOutputSchema)}`);
					return [
						`Scripts call your other tools as \`await tools.<name>(args)\` with the same arguments, by exactly these names, never with a prefix: ${callable.map((tool) => tool.name).join(", ")}.`,
						`Results are text${structured.length ? `, except these, which return objects: ${structured.join("; ")}` : ""}.`,
						"Scripts run on the phone in QuickJS, not in the sandbox; Date.now() only advances between tool calls. Use them to batch tool calls and shape data; heavy computation goes to bash.",
					].join("\n");
				}),
			],
		}),
	];
}
