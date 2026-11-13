import type { ToolCall } from "@earendil-works/pi-ai";
import type { ConversationId, EntryRecord } from "@earendil-works/pi-durable";
import { blocks, message } from "../agent/entries.ts";
import type { PendingForm } from "../interaction/forms.ts";
import { pageCards } from "../interaction/pages.ts";
import { ASK_USER } from "../interaction/tool.ts";
import { type Item, itemTrigger } from "../items/items.ts";
import { jobCommand, WAIT_MS } from "../jobs/background.ts";
import type { Trigger } from "../triggers/runs.ts";
import { type Bench, FOLDER, fileKey } from "./bench.ts";

export const GROUPS = ["need", "moving", "result", "scheduled"] as const;

export type Group = (typeof GROUPS)[number];

export type Step = { callId: string; name: string; status: "pending" | "running" | "done"; output: string; call: ToolCall | undefined };

export type Card =
	| { key: string; group: "need"; kind: "form"; callId: string; form: PendingForm }
	| { key: string; group: "need"; kind: "ask"; call: ToolCall; question: string }
	| { key: string; group: "need"; kind: "item"; item: Item }
	| { key: string; group: "need" | "moving"; kind: "browser"; handover: string | undefined }
	| { key: string; group: "moving"; kind: "watch"; agent: string; label: string; since: number }
	| { key: string; group: "moving"; kind: "turn"; steps: readonly Step[] }
	| { key: string; group: "result"; kind: "file"; path: string; title: string; summary: string; version: number }
	| { key: string; group: "scheduled"; kind: "schedule"; trigger: Trigger; at: number | undefined }
	| { key: string; group: "scheduled"; kind: "due"; item: Item; at: number };

export type Staged = Card | { key: typeof FOLDER; kind: "folder" };

export type LiveTool = { callId: string; name: string; status: "pending" | "running" | "done"; output?: string };

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

export type Board = { stage: Staged | undefined; pinned: boolean; tray: readonly { group: Group; cards: readonly Card[] }[] };

const MAX_RESULTS = 8;
const AGENT = "agent:";

export function boardOf(sources: Sources, bench: Bench): Board {
	const cards = cardsOf(sources, bench.opened);
	const tray = GROUPS.map((group) => ({ group, cards: cards.filter((card) => card.group === group) })).filter((section) => section.cards.length > 0);
	const first = (group: Group) => cards.find((card) => card.group === group);
	const picked: Staged | undefined = bench.pick === FOLDER ? { key: FOLDER, kind: "folder" } : cards.find((card) => card.key === bench.pick);
	if (picked) return { stage: picked, pinned: true, tray };
	const opened = bench.opened.toReversed().flatMap((path) => cards.filter((card) => card.key === fileKey(path)))[0];
	return { stage: first("need") ?? first("moving") ?? opened ?? first("scheduled") ?? first("result"), pinned: false, tray };
}

function cardsOf(sources: Sources, opened: readonly string[]): Card[] {
	const forms = [...sources.forms].flatMap(([callId, form]): Card[] => (form.conversationId === sources.bot ? [{ key: `form:${callId}`, group: "need", kind: "form", callId, form }] : []));
	const asks = openQuestions(sources.entries).map((call): Card => ({ key: `ask:${call.id}`, group: "need", kind: "ask", call, question: questionOf(call) }));
	const items = sources.items.filter((item) => item.bot === sources.bot);
	const todo = items.flatMap((item): Card[] => (item.state === "todo" ? [{ key: `item:${item.id}`, group: "need", kind: "item", item }] : []));
	const browser: Card[] = sources.browser.handover !== undefined ? [{ key: "browser", group: "need", kind: "browser", handover: sources.browser.handover }] : sources.browser.active ? [{ key: "browser", group: "moving", kind: "browser", handover: undefined }] : [];
	const mine = sources.triggers.filter((trigger) => trigger.conversationId === sources.bot);
	const watches = mine.flatMap((trigger): Card[] => (trigger.kind === "watch" ? [watchCard(trigger)] : []));
	const turn: Card[] = sources.tools.length > 0 ? [{ key: "turn", group: "moving", kind: "turn", steps: stepsOf(sources.tools, sources.entries) }] : [];
	const schedules = mine.flatMap((trigger): Card[] =>
		trigger.kind !== "watch" && trigger.state === "on" ? [{ key: `schedule:${trigger.id}`, group: "scheduled", kind: "schedule", trigger, at: sources.next[trigger.id] ?? (trigger.when.kind === "once" ? trigger.when.at : undefined) }] : [],
	);
	const dues = items.flatMap((item): Card[] => (item.state === "waiting" && item.nextAt !== undefined ? [{ key: `due:${item.id}`, group: "scheduled", kind: "due", item, at: sources.next[itemTrigger(item.id)] ?? item.nextAt }] : []));
	const scheduled = [...schedules, ...dues].toSorted((a, b) => timeOf(a) - timeOf(b));
	return [...forms, ...asks, ...browser.filter((card) => card.group === "need"), ...todo, ...browser.filter((card) => card.group === "moving"), ...watches, ...turn, ...filesOf(sources.entries, opened), ...scheduled];
}

function watchCard(trigger: Extract<Trigger, { kind: "watch" }>): Card {
	const { agent } = trigger;
	const job = agent.startsWith("job:");
	return { key: `${AGENT}${agent}`, group: "moving", kind: "watch", agent, label: job ? jobCommand(trigger.name) : agent, since: job ? trigger.createdAt - WAIT_MS : trigger.createdAt };
}

const timeOf = (card: Card): number => (card.kind === "schedule" || card.kind === "due" ? (card.at ?? Number.MAX_SAFE_INTEGER) : 0);

function toolCalls(entry: EntryRecord): ToolCall[] {
	if (entry.kind !== "pi.assistant") return [];
	return blocks(message(entry)?.content).flatMap((block) => (block.type === "toolCall" ? [block] : []));
}

function openQuestions(entries: readonly EntryRecord[]): ToolCall[] {
	const lastUser = entries.findLastIndex((entry) => entry.kind === "pi.user");
	return entries.slice(lastUser + 1).flatMap((entry) => toolCalls(entry).filter((call) => call.name === ASK_USER));
}

function questionOf(call: ToolCall): string {
	const question = call.arguments.question;
	return typeof question === "string" ? question : "";
}

function stepsOf(tools: readonly LiveTool[], entries: readonly EntryRecord[]): Step[] {
	const lastAnswer = entries.findLast((entry) => entry.kind === "pi.assistant");
	const calls = lastAnswer ? toolCalls(lastAnswer) : [];
	return tools.map((tool) => ({ callId: tool.callId, name: tool.name, status: tool.status, output: tool.output ?? "", call: calls.find((call) => call.id === tool.callId) }));
}

function filesOf(entries: readonly EntryRecord[], opened: readonly string[]): Card[] {
	const failed = new Map(
		entries.flatMap((entry) => {
			const result = message(entry);
			return result?.role === "toolResult" ? [[result.toolCallId, result.isError] as const] : [];
		}),
	);
	const succeeded = (callId: string) => failed.get(callId) === false;
	const pages = new Map([...pageCards(entries, succeeded).values()].map((page) => [page.path, page]));
	const writes = entries.flatMap((entry) => toolCalls(entry).filter((call) => (call.name === "write" || call.name === "edit") && typeof call.arguments.path === "string" && succeeded(call.id)));
	const versions = new Map<string, number>();
	for (const call of writes) versions.set(String(call.arguments.path), (versions.get(String(call.arguments.path)) ?? 0) + 1);
	const written = writes.map((call) => String(call.arguments.path)).toReversed();
	const paths = [...new Set([...opened.toReversed(), ...written])].slice(0, MAX_RESULTS);
	return paths.map((path) => {
		const page = pages.get(path);
		return { key: fileKey(path), group: "result", kind: "file", path, title: page?.title ?? nameOf(path), summary: page?.summary ?? "", version: versions.get(path) ?? 0 };
	});
}

export const nameOf = (path: string): string => path.split("/").at(-1) ?? path;
