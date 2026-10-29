import { type CodemodeRemote, type CodemodeRemoteExchange, RemoteCodemodeSandbox } from "@earendil-works/pi-codemode/portable";
import { defineExtension, section, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { createCodemodeTool } from "@earendil-works/pi-durable/codemode";
import type { FromWorker, ToWorker } from "./codemode-worker.ts";

const MEMORY_LIMIT_BYTES = 128 * 1024 * 1024;
const NOTHING_SHOWN = "Nothing came back: only what the script returns, text()s, or console.log()s reaches you. End it with `return <value>`.";
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

const STATEMENT = /^(?:return|throw|if|for|while|do|switch|try|function|async\s+function|class|import|export|break|continue|else|case|default|const|let|var)\b/;
const DECLARED = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/;

function compiles(code: string): boolean {
	try {
		// why: building the function compiles the script the way the sandbox wraps it, without running it, so a rewrite that breaks the syntax is caught here.
		new Function(`return (async (tools, console) => {${code}\n})`);
		return true;
	} catch (error) {
		if (error instanceof SyntaxError) return false;
		throw error;
	}
}

export function returnLast(code: string): string {
	const lines = code.split("\n");
	const meaningful = (line: string) => line.trim() !== "" && !line.trim().startsWith("//");
	const indent = (line: string) => line.length - line.trimStart().length;
	const top = Math.min(...lines.filter(meaningful).map(indent));
	const index = lines.findLastIndex((line) => meaningful(line) && indent(line) === top && !/^[)\]}.?]/.test(line.trim()));
	const head = lines[index]?.trimStart();
	if (head === undefined) return code;
	const declared = DECLARED.exec(head)?.[1];
	if (!declared && STATEMENT.test(head)) return code;
	const rewritten = declared ? `${code}\nreturn ${declared}` : lines.map((line, at) => (at === index ? line.replace(head, `return ${head}`) : line)).join("\n");
	return compiles(code) && compiles(rewritten) ? rewritten : code;
}

export function withSilenceHint(result: ToolExecutionResult): ToolExecutionResult {
	const [header, ...shown] = result.output ?? [];
	if (result.isError || shown.length > 0 || header?.type !== "text") return result;
	return { ...result, output: [header, { type: "text", text: NOTHING_SHOWN }] };
}

const remote = new WorkerRemote();

export function createPhoneCodemode(label: (extension: string, conversationId: string) => string | undefined) {
	const sandbox = new RemoteCodemodeSandbox({
		remote: () => remote,
		interruptBudget: INTERRUPT_BUDGET,
		memoryLimitBytes: MEMORY_LIMIT_BYTES,
	});
	const codemode = createCodemodeTool({ sandbox, models: false });
	return defineExtension({
		name: "codemode",
		tools: [{ ...codemode, execute: async (...[args, api, context]: Parameters<typeof codemode.execute>) => withSilenceHint(await codemode.execute({ ...args, code: returnLast(args.code) }, api, context)) }],
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
