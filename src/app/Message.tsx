import type { EntryRecord } from "@earendil-works/pi-durable";
import { useState } from "react";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { ChevronIcon } from "./icons.tsx";
import type { Prefs } from "./prefs.ts";

export type Block =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| { type: "image"; data: string; mimeType: string }
	| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

interface ModelMessage {
	role: string;
	content: string | Block[];
	stopReason?: string;
	errorMessage?: string;
	toolCallId?: string;
	isError?: boolean;
}

/** What the trace shows for a call: its result once done, or its live output while running. */
export interface CallState {
	status: "pending" | "running" | "done";
	isError?: boolean;
	output?: string;
}

export type CallStates = ReadonlyMap<string, CallState>;

function blocks(content: string | Block[] | undefined): Block[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return content ?? [];
}

function message(entry: EntryRecord): ModelMessage | undefined {
	return entry.model?.[0] as ModelMessage | undefined;
}

/** Results of finished calls, keyed by tool call ID, from the transcript's tool-result entries. */
export function finishedCalls(entries: readonly EntryRecord[]): Map<string, CallState> {
	const calls = new Map<string, CallState>();
	for (const entry of entries) {
		const result = message(entry);
		if (entry.kind !== "pi.tool-result" || !result?.toolCallId) continue;
		const output = blocks(result.content)
			.map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
			.join("\n");
		calls.set(result.toolCallId, { status: "done", isError: result.isError, output });
	}
	return calls;
}

/** Text of a message, for copying. */
export function entryText(entry: EntryRecord): string {
	return blocks(message(entry)?.content)
		.filter((block): block is Extract<Block, { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** One line describing a tool call: the command, path, or API route. */
function callLabel(name: string, args: Record<string, unknown>): string {
	if (name === "github_api") return `${args.method ?? "GET"} ${args.path ?? ""}`;
	if (name === "github_read_file") return `${args.owner}/${args.repo}/${args.path ?? ""}`;
	if (name === "bash" && typeof args.command === "string") return args.command;
	if (typeof args.path === "string") return args.path;
	const json = JSON.stringify(args);
	return json === "{}" ? "" : json;
}

const harnessTag = /<\/?harness>\n?/g;

function TraceRow({ call, state, prefs }: { call: Extract<Block, { type: "toolCall" }>; state: CallState | undefined; prefs: Prefs }) {
	const [open, setOpen] = useState(prefs.expandTools);
	const status = state?.status ?? "pending";
	const tone = status !== "done" ? "running" : state?.isError ? "error" : "ok";
	const output = state?.output?.replace(harnessTag, "").trim();
	return (
		<div className={`trace-row ${tone}`}>
			<button type="button" className="trace-head" onClick={() => setOpen(!open)} aria-expanded={open}>
				<span className="trace-dot" />
				<span className="trace-name">{call.name}</span>
				<span className="trace-label">{callLabel(call.name, call.arguments)}</span>
				{output ? <ChevronIcon open={open} /> : null}
			</button>
			{output && (open || status !== "done") ? (
				<pre className="console">{status === "done" ? output : output.split("\n").slice(-6).join("\n")}</pre>
			) : null}
		</div>
	);
}

function Thinking({ text }: { text: string }) {
	const [open, setOpen] = useState(false);
	const preview = text.trim().split("\n")[0] ?? "";
	return (
		<div className={`thinking${open ? " open" : ""}`}>
			<button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>
				<ChevronIcon open={open} />
				<span className="thinking-label">思考</span>
				{!open ? <span className="thinking-preview">{preview}</span> : null}
			</button>
			{open ? <div className="thinking-body">{text.trim()}</div> : null}
		</div>
	);
}

function Content({ content, prefs, calls, streaming }: { content: Block[]; prefs: Prefs; calls: CallStates; streaming?: boolean }) {
	// Consecutive tool calls form one trace group.
	const groups: (Block | Extract<Block, { type: "toolCall" }>[])[] = [];
	for (const block of content) {
		const last = groups.at(-1);
		if (block.type === "toolCall") {
			if (Array.isArray(last)) last.push(block);
			else groups.push([block]);
		} else groups.push(block);
	}
	const lastText = content.findLastIndex((block) => block.type === "text");
	return (
		<>
			{groups.map((group, index) => {
				if (Array.isArray(group)) {
					return (
						<div className="trace" key={index}>
							{group.map((call) => (
								<TraceRow key={call.id} call={call} state={calls.get(call.id)} prefs={prefs} />
							))}
						</div>
					);
				}
				switch (group.type) {
					case "text":
						return (
							<div className={`markdown${streaming && content[lastText] === group ? " caret" : ""}`} key={index}>
								<Markdown remarkPlugins={[remarkGfm, remarkBreaks]}>{group.text}</Markdown>
							</div>
						);
					case "thinking":
						return prefs.showThinking && group.thinking.trim() ? <Thinking key={index} text={group.thinking} /> : null;
					case "image":
						return <img className="attachment" key={index} src={`data:${group.mimeType};base64,${group.data}`} alt="" />;
				}
			})}
		</>
	);
}

export function StreamingAnswer({ content, prefs, calls }: { content: Block[]; prefs: Prefs; calls: CallStates }) {
	return (
		<article className="answer streaming">
			<Content content={content} prefs={prefs} calls={calls} streaming />
		</article>
	);
}

export function EntryView({
	entry,
	prefs,
	calls,
	onActions,
}: {
	entry: EntryRecord;
	prefs: Prefs;
	calls: CallStates;
	onActions: (entry: EntryRecord) => void;
}) {
	const model = message(entry);
	// Long press opens the message actions (copy, fork), like a context menu.
	const longPress = {
		onContextMenu: (event: { preventDefault: () => void }) => {
			event.preventDefault();
			onActions(entry);
		},
	};
	if (entry.kind === "pi.compaction") return <div className="divider">較早的對話已壓縮成摘要</div>;
	if (entry.kind === "pi.reset") return <div className="divider">新的上下文</div>;
	if (!model) return null;
	if (entry.kind === "pi.user") {
		return (
			<section className="prompt" {...longPress}>
				<Content content={blocks(model.content)} prefs={prefs} calls={calls} />
			</section>
		);
	}
	if (entry.kind === "pi.assistant") {
		const aborted = model.stopReason === "aborted";
		return (
			<article className={`answer${aborted ? " aborted" : ""}`} {...longPress}>
				<Content content={blocks(model.content)} prefs={prefs} calls={calls} />
				{aborted ? <div className="note">已中斷</div> : null}
				{model.errorMessage && !aborted ? <div className="note error">{model.errorMessage}</div> : null}
			</article>
		);
	}
	// Tool results render inside the trace of the call that produced them.
	return null;
}
