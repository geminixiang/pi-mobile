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
		worker.addEventListener("error", () => {
			for (const entry of this.#runs.values()) entry.done();
			this.#runs.clear();
			worker.terminate();
			if (this.#worker === worker) this.#worker = undefined;
		});
		return worker;
	}
}

export function signatureOf(tool: { name: string; parameters: unknown }): string {
	const schema = tool.parameters;
	const properties: unknown = typeof schema === "object" && schema !== null ? Reflect.get(schema, "properties") : undefined;
	const required: unknown = typeof schema === "object" && schema !== null ? Reflect.get(schema, "required") : undefined;
	const needed = new Set(Array.isArray(required) ? required : []);
	const names = typeof properties === "object" && properties !== null ? Object.keys(properties) : [];
	return `${tool.name}(${names.map((name) => (needed.has(name) ? name : `${name}?`)).join(", ")})`;
}

const remote = new WorkerRemote();

export function createPhoneCodemode(label: (extension: string, conversationId: string) => string | undefined) {
	const sandbox = new RemoteCodemodeSandbox({
		remote: () => remote,
		interruptBudget: INTERRUPT_BUDGET,
		memoryLimitBytes: MEMORY_LIMIT_BYTES,
	});
	return defineExtension({
		name: "codemode",
		tools: [createCodemodeTool({ sandbox, models: false })],
		sections: [
			section("codemode", (input) => {
				const offered = new Set([...input.agent.tools, ...input.agent.deferred].map((tool) => tool.name));
				const callable = new Set(input.agent.callable.map((tool) => tool.name));
				const lines = input.agent.extensions.flatMap((extension) => {
					const name = label(extension.name, String(input.conversationId));
					const tools = (extension.tools ?? []).filter((tool) => !offered.has(tool.name) && callable.has(tool.name));
					return name && tools.length > 0 ? [`- ${name}: ${tools.map(signatureOf).join("; ")}`] : [];
				});
				if (lines.length === 0) return undefined;
				return [
					"These tools are called only from codemode scripts, as `await tools.<name>({ ...args })`, by exactly these names: put every call a task needs in one script (Promise.all for independent ones), shape the results there, and return only what the answer needs. When a tool's arguments or result are not obvious from its name, `return describeTool(name)` first. Look up rather than guess or ask: the phone's place and time, weather, travel times (no transit: estimate and say so).",
					...lines,
					"Scripts run on the phone in QuickJS, not on a computer; Date.now() only advances between tool calls. Heavy computation goes to bash.",
				].join("\n");
			}),
		],
	});
}
