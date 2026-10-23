import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { AgentRuntime, type ConversationId } from "../../src/agent/runtime.ts";
import { faux, settings } from "./setup.ts";

export const context = BACKGROUND_CONTEXT;

export function keepOpen(memory: MemoryStorage): MemoryStorage {
	return new Proxy(memory, {
		get(target, key) {
			if (key === "close") return async () => undefined;
			const value: unknown = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

export async function openRuntime(storage: MemoryStorage = new MemoryStorage(), overrides: Partial<typeof settings> = {}) {
	const reports: string[] = [];
	const runtime = await AgentRuntime.open(storage, { ...settings, ...overrides }, { onReport: (message) => reports.push(message) });
	return { runtime, reports, storage };
}

export async function agentState(runtime: AgentRuntime, id: ConversationId): Promise<unknown> {
	const controller = await runtime.openConversation(id);
	let docs: unknown;
	controller.subscribe((view) => (docs = view.docs["pi.agent"]))();
	controller.dispose();
	return docs;
}

export async function idle(runtime: AgentRuntime, id: ConversationId, timeoutMs = 5000): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		let started = false;
		const timer = setTimeout(() => {
			stop();
			reject(new Error(`conversation ${id} still busy after ${timeoutMs} ms`));
		}, timeoutMs);
		const stop = runtime.subscribeActivity((busy) => {
			if (busy.has(id)) started = true;
			else if (started) {
				clearTimeout(timer);
				setTimeout(() => {
					stop();
					resolve();
				});
			}
		});
	});
}

export async function turn(runtime: AgentRuntime, id: ConversationId, steps: FauxResponseStep[], text = "go"): Promise<void> {
	faux.setResponses(steps);
	const controller = await runtime.openConversation(id);
	const done = idle(runtime, id);
	await controller.send([{ type: "text", text }]);
	await done;
	controller.dispose();
}

export async function toolResults(storage: MemoryStorage, id: ConversationId) {
	const page = await storage.scanEntries({ conversationId: id }, 200, undefined, context);
	return page.items.flatMap((entry) =>
		entry.kind === "pi.tool-result"
			? (entry.model ?? []).flatMap((message) =>
					message.role === "toolResult"
						? [{ name: message.toolName, isError: message.isError, text: message.content.map((part) => (part.type === "text" ? part.text : "")).join("") }]
						: [],
				)
			: [],
	);
}

export async function entriesOf(storage: MemoryStorage, id: ConversationId, kind: string): Promise<number> {
	const page = await storage.scanEntries({ conversationId: id }, 200, undefined, context);
	return page.items.filter((entry) => entry.kind === kind).length;
}
