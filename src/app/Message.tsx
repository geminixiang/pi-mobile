import type { EntryRecord } from "@earendil-works/pi-durable";
import { type ComponentProps, useContext, useState } from "react";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkGfm from "remark-gfm";
import { ChevronIcon, FileIcon } from "./icons.tsx";
import type { Prefs } from "./prefs.ts";
import { OpenFileContext, resolvePath } from "./openFile.ts";

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
	// Code mode: the script's first line that is not a comment or option header.
	if (name === "codemode" && typeof args.code === "string") {
		return args.code.split("\n").find((line) => line.trim() && !line.trim().startsWith("//"))?.trim() ?? "";
	}
	if (typeof args.path === "string") return args.path;
	const json = JSON.stringify(args);
	return json === "{}" ? "" : json;
}

const harnessTag = /<\/?harness>\n?/g;

type Call = Extract<Block, { type: "toolCall" }>;
type Tone = "running" | "error" | "ok";

function tone(state: CallState | undefined): Tone {
	if (state?.status !== "done") return "running";
	return state.isError ? "error" : "ok";
}

/** Short tool label, as pi's TUI prints it. */
function toolName(name: string): string {
	if (name === "github_api") return "github";
	if (name === "github_read_file") return "github read";
	if (name === "device_info") return "device";
	if (name === "codemode") return "script";
	return name;
}

function StepRow({ call, state, prefs }: { call: Call; state: CallState | undefined; prefs: Prefs }) {
	const [open, setOpen] = useState(prefs.expandTools);
	const status = tone(state);
	const output = state?.output?.replace(harnessTag, "").trim();
	const openFile = useContext(OpenFileContext);
	const filePath = ["read", "write", "edit"].includes(call.name) && typeof call.arguments.path === "string" ? call.arguments.path : undefined;
	return (
		<div className={`step ${status}`}>
			{openFile && filePath && status !== "running" ? (
				<button type="button" className="step-open" onClick={() => openFile(resolvePath(filePath))} aria-label="開啟檔案">
					<FileIcon size={14} />
				</button>
			) : null}
			<button type="button" className="step-head" onClick={() => setOpen(!open)} aria-expanded={open} disabled={!output && call.name !== "codemode"}>
				<span className="step-name">{toolName(call.name)}</span>
				<span className="step-label">{callLabel(call.name, call.arguments)}</span>
				{status === "running" ? <span className="block-cursor" aria-label="執行中" /> : null}
				{status === "error" ? <span className="step-status">失敗</span> : null}
				{output && status !== "running" ? <ChevronIcon open={open} size={12} /> : null}
			</button>
			{open && call.name === "codemode" && typeof call.arguments.code === "string" ? (
				<pre className="console script">{call.arguments.code}</pre>
			) : null}
			{output && (open || status === "running") ? (
				<pre className="console">{status === "running" ? output.split("\n").slice(-6).join("\n") : output}</pre>
			) : null}
		</div>
	);
}

/** Consecutive tool calls, stacked like pi's tool boxes. Long finished runs fold into one line. */
function Steps({ group, calls, prefs }: { group: Call[]; calls: CallStates; prefs: Prefs }) {
	const tones = group.map((call) => tone(calls.get(call.id)));
	const foldable = group.length > 3 && !tones.includes("running");
	const failed = tones.filter((value) => value === "error").length;
	const [open, setOpen] = useState(prefs.expandTools);
	return (
		<div className="steps">
			{foldable ? (
				<button type="button" className="steps-summary" onClick={() => setOpen(!open)} aria-expanded={open}>
					<span>
						{group.length} 個步驟{failed ? `，${failed} 個失敗` : ""}
					</span>
					<span className="steps-names">{[...new Set(group.map((call) => toolName(call.name)))].join(" · ")}</span>
					<ChevronIcon open={open} size={12} />
				</button>
			) : null}
			{!foldable || open
				? group.map((call) => <StepRow key={call.id} call={call} state={calls.get(call.id)} prefs={prefs} />)
				: null}
		</div>
	);
}

function Thinking({ text, streaming }: { text: string; streaming?: boolean }) {
	const [open, setOpen] = useState(false);
	const preview = text.trim().split("\n")[0] ?? "";
	return (
		<div className={`thinking${open ? " open" : ""}`}>
			<button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>
				<span className="thinking-label">{streaming ? "思考中" : "思考"}</span>
				{!open ? <span className="thinking-preview">{preview}</span> : null}
				<ChevronIcon open={open} size={12} />
			</button>
			{open ? <div className="thinking-body">{text.trim()}</div> : null}
		</div>
	);
}

/** Fenced code with a language label and a copy button. */
function CodeBlock({ children }: ComponentProps<"pre">) {
	const [copied, setCopied] = useState(false);
	const code = (children as { props?: { className?: string; children?: unknown } } | undefined)?.props;
	const language = /language-(\S+)/.exec(code?.className ?? "")?.[1] ?? "";
	const source = String(code?.children ?? "").replace(/\n$/, "");
	return (
		<div className="code">
			<div className="code-head">
				<span>{language || "text"}</span>
				<button
					type="button"
					onClick={() =>
						void navigator.clipboard.writeText(source).then(() => {
							setCopied(true);
							setTimeout(() => setCopied(false), 1500);
						})
					}
				>
					{copied ? "已複製" : "複製"}
				</button>
			</div>
			<pre>{children}</pre>
		</div>
	);
}

export const markdownComponents = { pre: CodeBlock };
// CJK-friendly emphasis: CommonMark misses **粗體**是 when the closing ** follows CJK punctuation.
export const remarkPlugins = [remarkGfm, remarkCjkFriendly, remarkBreaks];

function Content({ content, prefs, calls, streaming }: { content: Block[]; prefs: Prefs; calls: CallStates; streaming?: boolean }) {
	// Consecutive tool calls form one trace group.
	const groups: (Block | Call[])[] = [];
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
					return <Steps key={index} group={group} calls={calls} prefs={prefs} />;
				}
				switch (group.type) {
					case "text":
						return (
							<div className={`markdown${streaming && content[lastText] === group ? " caret" : ""}`} key={index}>
								<Markdown remarkPlugins={remarkPlugins} components={markdownComponents}>
									{group.text}
								</Markdown>
							</div>
						);
					case "thinking":
						return prefs.showThinking && group.thinking.trim() ? (
							<Thinking key={index} text={group.thinking} streaming={streaming && index === groups.length - 1} />
						) : null;
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
			<section className="prompt" {...longPress} onClick={() => onActions(entry)}>
				<div className="bubble">
					<Content content={blocks(model.content)} prefs={prefs} calls={calls} />
				</div>
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
