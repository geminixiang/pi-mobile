import { Type } from "typebox";
import { type CodemodeRemote, type CodemodeRemoteExchange, RemoteCodemodeSandbox } from "@earendil-works/pi-codemode/portable";
import { defineExtension, hook, type ToolExecutionResult, ToolTask } from "@earendil-works/pi-durable";
import { appSection } from "./section.ts";
import { adopt } from "./tools/common.ts";
import { createCodemodeTool } from "@earendil-works/pi-durable/codemode";
import type { FromWorker, ToWorker } from "./codemode-worker.ts";

const MEMORY_LIMIT_BYTES = 128 * 1024 * 1024;
const NOTHING_SHOWN = "Nothing came back: only what the script returns, text()s, or console.log()s reaches you. End it with `return <value>`.";

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
const CONTINUATION = /^[)\]}.?:,+\-*/%&|]/;

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

function lastStatement(line: string): { start: number; closed: boolean } {
	let depth = 0;
	let quote = "";
	let start = line.length - line.trimStart().length;
	let afterSemicolon: number | undefined;
	for (let at = start; at < line.length; at++) {
		const char = line.charAt(at);
		if (quote) {
			if (char === "\\") at++;
			else if (char === quote) quote = "";
			continue;
		}
		if (char === "/" && line.charAt(at + 1) === "/") break;
		if (char === " " || char === "\t") continue;
		if (char === ";" && depth === 0) {
			afterSemicolon = at + 1;
			continue;
		}
		if (afterSemicolon !== undefined) start = at;
		afterSemicolon = undefined;
		if (`"'\``.includes(char)) quote = char;
		else if ("([{".includes(char)) depth++;
		else if (")]}".includes(char)) depth--;
	}
	return { start, closed: quote === "" && depth === 0 };
}

export function returnLast(code: string): string {
	const lines = code.split("\n");
	const meaningful = (line: string) => line.trim() !== "" && !line.trim().startsWith("//");
	const indent = (line: string) => line.length - line.trimStart().length;
	const top = Math.min(...lines.filter(meaningful).map(indent));
	const index = lines.findLastIndex((line) => meaningful(line) && indent(line) === top && !CONTINUATION.test(line.trim()));
	const line = lines[index];
	if (line === undefined) return code;
	const { start, closed } = lastStatement(line);
	const head = line.slice(start);
	const declared = DECLARED.exec(head)?.[1];
	const followed = lines.slice(index + 1).some((line) => meaningful(line) && !CONTINUATION.test(line.trim()));
	// why: the scan does not know regex literals, so an open quote or bracket may mean it lost a statement boundary; a return placed before that boundary would skip what follows it
	if (!declared && (!closed || STATEMENT.test(head) || followed)) return code;
	const rewritten = declared ? `${code}\nreturn ${declared}` : lines.map((other, at) => (at === index ? `${line.slice(0, start)}return ${head}` : other)).join("\n");
	return compiles(code) && compiles(rewritten) ? rewritten : code;
}

function scriptHint(name: string): string {
	return `${name} is not offered to you directly. If it is listed among the codemode tools, call it from a codemode script: await tools.${name}({ ...args }). Otherwise there is no such tool here.`;
}

export function withSilenceHint(result: ToolExecutionResult): ToolExecutionResult {
	const [header, ...shown] = result.output ?? [];
	if (result.isError || shown.length > 0 || header?.type !== "text") return result;
	return { ...result, output: [header, { type: "text", text: NOTHING_SHOWN }] };
}

const remote = new WorkerRemote();

export function createPhoneCodemode(label: (tool: string, extension: string, conversationId: string) => string | undefined) {
	const sandbox = new RemoteCodemodeSandbox({
		remote: () => remote,
		memoryLimitBytes: MEMORY_LIMIT_BYTES,
	});
	const codemode = createCodemodeTool({ sandbox, models: false });
	const parameters = Type.Object({
		title: Type.Optional(Type.String({ description: "What this does, for the user to read while it runs: a few words in the user's language, such as 查詢台北天氣" })),
		code: Type.String({ description: "Raw JavaScript source." }),
	});
	return defineExtension({
		name: "codemode",
		hooks: [
			hook(ToolTask, {
				afterTool: (call, result) =>
					call.parent === undefined && result.diagnostics?.some((diagnostic) => diagnostic.code === "tool_unavailable") ? { ...result, output: [{ type: "text", text: scriptHint(call.name) }] } : undefined,
			}),
		],
		tools: [
			adopt(
				{ ...codemode, parameters, execute: async (...[args, api, context]: Parameters<typeof codemode.execute>) => withSilenceHint(await codemode.execute({ ...args, code: returnLast(args.code) }, api, context)) },
				{ groups: "always", effect: "direct", needs: [] },
			),
		],
		sections: [
			appSection("codemode", 4_000, (input) => {
				const offered = new Set([...input.agent.tools, ...input.agent.deferred].map((tool) => tool.name));
				const callable = new Set(input.agent.callable.map((tool) => tool.name));
				const grouped = new Map<string, string[]>();
				for (const extension of input.agent.extensions) {
					for (const tool of (extension.tools ?? []).filter((candidate) => !offered.has(candidate.name) && callable.has(candidate.name))) {
						const name = label(tool.name, extension.name, String(input.conversationId));
						if (name) grouped.set(name, [...(grouped.get(name) ?? []), signatureOf(tool)]);
					}
				}
				const lines = [...grouped].map(([name, signatures]) => `- ${name}: ${signatures.join("; ")}`);
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
