import { contentText, type ToolCall } from "@earendil-works/pi-ai";
import type { ConversationId, EntryRecord } from "@earendil-works/pi-durable";
import { blocks, entryText, message } from "../agent/entries.ts";
import type { PendingForm } from "../interaction/forms.ts";
import { pageCards } from "../interaction/pages.ts";
import { ASK_USER } from "../interaction/tool.ts";
import { type Item, itemTrigger } from "../items/items.ts";
import { jobCommand, WAIT_MS } from "../jobs/background.ts";
import { type Trigger, triggerRun } from "../triggers/runs.ts";
import { type Bench, FOLDER, fileKey } from "./bench.ts";

export const GROUPS = ["need", "moving", "result"] as const;

export type Group = (typeof GROUPS)[number];

export type Step = { callId: string; name: string; status: "pending" | "running" | "done"; output: string; call: ToolCall | undefined };

export type Draft = { path: string; version: number; previous: string | undefined };

export type Source = { url: string; title: string; read: string };

export type Card =
	| { key: string; group: "need"; kind: "form"; callId: string; form: PendingForm }
	| { key: string; group: "need"; kind: "ask"; call: ToolCall; question: string; options: readonly string[]; draft: Draft | undefined }
	| { key: string; group: "need"; kind: "item"; item: Item }
	| { key: string; group: "need" | "moving"; kind: "browser"; handover: string | undefined }
	| { key: string; group: "moving"; kind: "watch"; agent: string; label: string; since: number }
	| { key: string; group: "moving"; kind: "turn"; steps: readonly Step[] }
	| { key: string; group: "result"; kind: "sources"; sources: readonly Source[] }
	| { key: string; group: "result"; kind: "file"; path: string; title: string; summary: string; version: number; previous: string | undefined; living: Living | undefined };

type Living = { schedule: string; at: number | undefined };

type Staged = Card | { key: typeof FOLDER; kind: "folder" };

type LiveTool = { callId: string; name: string; status: "pending" | "running" | "done"; output?: string };

export type Sources = {
	bot: ConversationId;
	entries: readonly EntryRecord[];
	tools: readonly LiveTool[];
	forms: ReadonlyMap<string, PendingForm>;
	items: readonly Item[];
	triggers: readonly Trigger[];
	next: Readonly<Record<string, number>>;
	browser: { active: boolean; handover: string | undefined };
};

export type Board = {
	stage: Staged | undefined;
	pinned: boolean;
	tray: readonly { group: Group; cards: readonly Card[] }[];
	queue: { at: number; total: number } | undefined;
	next: { name: string; at: number } | undefined;
};

const MAX_RESULTS = 8;
const AGENT = "agent:";
const URL_IN_TEXT = /https?:\/\/[^\s)'"`<>\]]+/g;
const LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
const READ_CHARS = 4000;

export function boardOf(sources: Sources, bench: Bench): Board {
	const cards = cardsOf(sources, bench.opened);
	const tray = GROUPS.map((group) => ({ group, cards: cards.filter((card) => card.group === group) })).filter((section) => section.cards.length > 0);
	const needs = cards.filter((card) => card.group === "need");
	const drafting = (card: Card) => card.kind === "ask" && card.draft !== undefined && fileKey(card.draft.path) === bench.pick;
	const picked: Staged | undefined = bench.pick === FOLDER ? { key: FOLDER, kind: "folder" } : (cards.find((card) => card.key === bench.pick) ?? cards.find(drafting));
	const opened = bench.opened.toReversed().flatMap((path) => cards.filter((card) => card.key === fileKey(path)))[0];
	const living = cards.find((card) => card.kind === "file" && card.living !== undefined);
	const stage = picked ?? needs[0] ?? cards.find((card) => card.group === "moving") ?? opened ?? living ?? cards.find((card) => card.group === "result");
	const at = needs.findIndex((card) => card.key === stage?.key);
	return { stage, pinned: picked !== undefined, tray, queue: at >= 0 ? { at: at + 1, total: needs.length } : undefined, next: nextOf(sources) };
}

function cardsOf(sources: Sources, opened: readonly string[]): Card[] {
	const turn = sources.entries.slice(sources.entries.findLastIndex((entry) => entry.kind === "pi.user") + 1);
	const outcomes = resultsOf(sources.entries);
	const files = filesOf(sources.entries, outcomes, opened);
	const forms = [...sources.forms].flatMap(([callId, form]): Card[] => (form.conversationId === sources.bot ? [{ key: `form:${callId}`, group: "need", kind: "form", callId, form }] : []));
	const asks = turn.flatMap(toolCalls).flatMap((call, index, calls): Card[] => (call.name === ASK_USER ? [askCard(call, draftOf(calls.slice(0, index), outcomes, files))] : []));
	const items = sources.items.filter((item) => item.bot === sources.bot);
	const todo = items.flatMap((item): Card[] => (item.state === "todo" ? [{ key: `item:${item.id}`, group: "need", kind: "item", item }] : []));
	const browser: Card[] = sources.browser.handover !== undefined ? [{ key: "browser", group: "need", kind: "browser", handover: sources.browser.handover }] : sources.browser.active ? [{ key: "browser", group: "moving", kind: "browser", handover: undefined }] : [];
	const watches = sources.triggers.flatMap((trigger): Card[] => (trigger.kind === "watch" && trigger.conversationId === sources.bot ? [watchCard(trigger)] : []));
	const live: Card[] = sources.tools.length > 0 ? [{ key: "turn", group: "moving", kind: "turn", steps: stepsOf(sources.tools, sources.entries) }] : [];
	const read = readOf(turn, outcomes);
	const evidence: Card[] = read.length > 0 ? [{ key: "sources", group: "result", kind: "sources", sources: read }] : [];
	const drafts = new Set(asks.flatMap((card) => (card.kind === "ask" && card.draft ? [card.draft.path] : [])));
	const results = files.filter((card) => !(card.kind === "file" && drafts.has(card.path)));
	return [...forms, ...asks, ...browser.filter((card) => card.group === "need"), ...todo, ...browser.filter((card) => card.group === "moving"), ...watches, ...live, ...evidence, ...results];
}

function askCard(call: ToolCall, draft: Draft | undefined): Card {
	const { question, options } = call.arguments;
	const choices = Array.isArray(options) ? options.flatMap((option) => (typeof option === "string" ? [option] : [])) : [];
	return { key: `ask:${call.id}`, group: "need", kind: "ask", call, question: typeof question === "string" ? question : "", options: choices, draft };
}

function draftOf(before: readonly ToolCall[], results: ReadonlyMap<string, Result>, files: readonly Card[]): Draft | undefined {
	const written = before.findLast((call) => isWrite(call) && results.get(call.id)?.isError === false);
	const path = written ? String(written.arguments.path) : undefined;
	const file = files.find((card) => card.kind === "file" && card.path === path);
	return file?.kind === "file" ? { path: file.path, version: file.version, previous: file.previous } : undefined;
}

function nextOf(sources: Sources): Board["next"] {
	const schedules = sources.triggers.flatMap((trigger) => {
		if (trigger.conversationId !== sources.bot || trigger.kind === "watch" || trigger.state !== "on") return [];
		const at = sources.next[trigger.id] ?? (trigger.when.kind === "once" ? trigger.when.at : undefined);
		return at === undefined ? [] : [{ name: trigger.name, at }];
	});
	const items = sources.items.flatMap((item) => (item.bot === sources.bot && item.nextAt !== undefined ? [{ name: item.title, at: sources.next[itemTrigger(item.id)] ?? item.nextAt }] : []));
	return [...schedules, ...items].toSorted((a, b) => a.at - b.at)[0];
}

function watchCard(trigger: Extract<Trigger, { kind: "watch" }>): Card {
	const { agent } = trigger;
	const job = agent.startsWith("job:");
	return { key: `${AGENT}${agent}`, group: "moving", kind: "watch", agent, label: job ? jobCommand(trigger.name) : agent, since: job ? trigger.createdAt - WAIT_MS : trigger.createdAt };
}

type Result = { isError: boolean; text: string };

function resultsOf(entries: readonly EntryRecord[]): ReadonlyMap<string, Result> {
	return new Map(
		entries.flatMap((entry) => {
			const result = message(entry);
			return result?.role === "toolResult" ? [[result.toolCallId, { isError: result.isError, text: contentText(result.content) }] as const] : [];
		}),
	);
}

function toolCalls(entry: EntryRecord): ToolCall[] {
	if (entry.kind !== "pi.assistant") return [];
	return blocks(message(entry)?.content).flatMap((block) => (block.type === "toolCall" ? [block] : []));
}

const isWrite = (call: ToolCall) => (call.name === "write" || call.name === "edit") && typeof call.arguments.path === "string";

function stepsOf(tools: readonly LiveTool[], entries: readonly EntryRecord[]): Step[] {
	const lastAnswer = entries.findLast((entry) => entry.kind === "pi.assistant");
	const calls = lastAnswer ? toolCalls(lastAnswer) : [];
	return tools.map((tool) => ({ callId: tool.callId, name: tool.name, status: tool.status, output: tool.output ?? "", call: calls.find((call) => call.id === tool.callId) }));
}

type Written = { call: ToolCall; by: Living | undefined };

function writesOf(entries: readonly EntryRecord[], succeeded: (callId: string) => boolean): Written[] {
	const written: Written[] = [];
	let by: Living | undefined;
	for (const entry of entries) {
		const run = triggerRun(entry);
		if (run) by = { schedule: run.name, at: run.at };
		if (entry.kind === "pi.user") by = undefined;
		for (const call of toolCalls(entry)) if (isWrite(call) && succeeded(call.id)) written.push({ call, by });
	}
	return written;
}

function filesOf(entries: readonly EntryRecord[], results: ReadonlyMap<string, Result>, opened: readonly string[]): Card[] {
	const succeeded = (callId: string) => results.get(callId)?.isError === false;
	const pages = new Map([...pageCards(entries, succeeded).values()].map((page) => [page.path, page]));
	const writes = writesOf(entries, succeeded);
	const pathOf = (write: Written) => String(write.call.arguments.path);
	const written = writes.map(pathOf).toReversed();
	const living = new Set(writes.flatMap((write) => (write.by ? [pathOf(write)] : [])));
	const paths = [...new Set([...opened.toReversed(), ...written])].slice(0, MAX_RESULTS).toSorted((a, b) => Number(living.has(b)) - Number(living.has(a)));
	return paths.map((path) => {
		const page = pages.get(path);
		const mine = writes.filter((write) => pathOf(write) === path);
		const [before, last] = mine.slice(-2).map((write) => write.call);
		const previous = before?.name === "write" && last?.name === "write" && typeof before.arguments.content === "string" ? before.arguments.content : undefined;
		return { key: fileKey(path), group: "result", kind: "file", path, title: page?.title ?? nameOf(path), summary: page?.summary ?? "", version: mine.length, previous, living: mine.findLast((write) => write.by)?.by };
	});
}

function readOf(turn: readonly EntryRecord[], results: ReadonlyMap<string, Result>): Source[] {
	const found = new Map<string, Source>();
	const add = (url: string, title: string, read: string) => {
		const known = found.get(url);
		found.set(url, { url, title: known && known.title !== hostOf(url) ? known.title : title, read: known?.read || read.slice(0, READ_CHARS) });
	};
	for (const call of turn.flatMap(toolCalls)) {
		const text = results.get(call.id)?.text ?? "";
		if (call.name === "web_fetch" && typeof call.arguments.url === "string") add(call.arguments.url, hostOf(call.arguments.url), text);
		if (call.name === "web_search") for (const line of text.split("\n")) listed(line, add, text);
		if (call.name === "codemode" && typeof call.arguments.code === "string") {
			for (const url of call.arguments.code.match(URL_IN_TEXT) ?? []) add(url, hostOf(url), afterOutput(text));
			for (const line of text.split("\n")) listed(line, add, text);
		}
	}
	const answer = turn.findLast((entry) => entry.kind === "pi.assistant");
	for (const [, title, url] of (answer ? entryText(answer) : "").matchAll(LINK)) if (title && url && found.has(url)) add(url, title, "");
	return [...found.values()];
}

function listed(line: string, add: (url: string, title: string, read: string) => void, read: string): void {
	const at = line.lastIndexOf(": http");
	if (!line.startsWith("- ") || at < 0) return;
	add(line.slice(at + 2).trim(), line.slice(2, at).trim(), read);
}

const OUTPUT = "Output:\n";

const afterOutput = (text: string): string => (text.includes(OUTPUT) ? text.slice(text.indexOf(OUTPUT) + OUTPUT.length).trim() : text);

export const hostOf = (url: string): string => (URL.canParse(url) ? new URL(url).hostname : url);

export const nameOf = (path: string): string => path.split("/").at(-1) ?? path;
