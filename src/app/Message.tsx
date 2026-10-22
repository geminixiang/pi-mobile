import type { ImageContent, Message as ModelMessage, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { type ComponentProps, lazy, memo, Suspense, useContext, useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkGfm from "remark-gfm";
import { ChevronIcon, CloseIcon, FileIcon } from "./icons.tsx";
import { type AttachmentCard, parseAttachment, withoutAttachments } from "../agent/attachments.ts";
import { isCodeNote } from "../agent/codes.ts";
import type { Prefs } from "./prefs.ts";
import { StreamingMarkdown } from "./streaming.tsx";
import { OpenFileContext } from "./openFile.ts";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { TRIGGER_ENTRY, TriggerEntryData } from "../agent/triggers.ts";

const DELIVERY: Record<string, string> = { live: "", later: " · 打開後執行", manual: " · 手動執行" };

/** One content part of any message the transcript shows. */
export type Block = TextContent | ThinkingContent | ImageContent | ToolCall;

/**
 * What the trace shows for a call. Running calls have live output; finished calls have their result, and only they
 * can have failed or carry images (such as a chart the agent read back from the sandbox).
 */
export type CallState =
	| { status: "pending" }
	| { status: "running"; output?: string }
	| { status: "done"; isError: boolean; output: string; images: ImageContent[] };

export type CallStates = ReadonlyMap<string, CallState>;

function blocks(content: string | readonly Block[] | undefined): readonly Block[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return content ?? [];
}

function message(entry: EntryRecord): ModelMessage | undefined {
	return entry.model?.[0];
}

/** Results of finished calls, keyed by tool call ID, from the transcript's tool-result entries. */
export function finishedCalls(entries: readonly EntryRecord[]): Map<string, CallState> {
	const calls = new Map<string, CallState>();
	for (const entry of entries) {
		const result = message(entry);
		if (result?.role !== "toolResult") continue;
		const output = result.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		const images = result.content.filter((block) => block.type === "image");
		calls.set(result.toolCallId, { status: "done", isError: result.isError, output, images });
	}
	return calls;
}

const KIND_LABEL: Record<AttachmentCard["kind"], string> = { pdf: "PDF", docx: "Word", sheet: "試算表", text: "文字" };

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** An attached file, in the user's message and the composer: its name, kind, and size; its text is the model's. */
export function AttachmentChip({ card, status, onRemove }: { card: Pick<AttachmentCard, "name" | "kind" | "size" | "pages">; status?: string; onRemove?: () => void }) {
	const detail = status ?? [KIND_LABEL[card.kind], card.pages ? `${card.pages} 頁` : "", formatSize(card.size)].filter(Boolean).join(" · ");
	const body = (
		<>
			<FileIcon size={18} />
			<span className="file-chip-text">
				<span className="file-chip-name">{card.name}</span>
				<span className="file-chip-detail">{detail}</span>
			</span>
		</>
	);
	return onRemove ? (
		<button type="button" className="file-chip" onClick={onRemove} aria-label={`移除 ${card.name}`}>
			{body}
			<CloseIcon size={12} />
		</button>
	) : (
		<div className="file-chip">{body}</div>
	);
}

/** Text of a message, for copying: without its attachments' text. */
export function entryText(entry: EntryRecord): string {
	return withoutAttachments(blocks(message(entry)?.content))
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

const ON_LABEL: Record<string, string> = { headphones: "戴上耳機時", charging: "開始充電時", wifi: "連上 Wi‑Fi 時", arrive: "到達時", leave: "離開時" };

const str = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");
const join = (...parts: string[]): string => parts.filter(Boolean).join(" · ");

/** "2026-10-31T10:00" -> "10/31 10:00"; other text unchanged. */
function shortTime(value: unknown): string {
	const match = /^\d{4}-(\d{2})-(\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(str(value));
	return match ? `${Number(match[1])}/${Number(match[2])}${match[3] ? ` ${match[3]}` : ""}` : str(value);
}

/** What the phone's own tools did, in words instead of their JSON arguments. */
function phoneLabel(name: string, args: Record<string, unknown>): string | undefined {
	switch (name) {
		case "set_alarm":
			return join(str(args.time), str(args.label), Array.isArray(args.repeat) ? `重複 ${args.repeat.length} 天` : "");
		case "set_timer": {
			const seconds = Number(args.seconds) || 0;
			const time = seconds >= 60 ? `${Math.floor(seconds / 60)} 分${seconds % 60 ? ` ${seconds % 60} 秒` : ""}` : `${seconds} 秒`;
			return join(time, str(args.label));
		}
		case "compose_email":
			return join(Array.isArray(args.to) ? args.to.map(str).join(", ") : "", str(args.subject));
		case "compose_sms":
			return str(args.to);
		case "open_maps":
		case "get_travel_time":
			return join(str(args.origin) ? `${str(args.origin)} → ${str(args.destination)}` : str(args.destination), str(args.mode));
		case "open_link":
			return str(args.url);
		case "share":
			// sandbox_path: what the file was called before the phone folder.
			return str(args.path) || str(args.sandbox_path) || str(args.title) || str(args.text).slice(0, 40);
		case "read_calendar_events":
			return join(args.from || args.to ? `${shortTime(args.from) || "現在"} → ${shortTime(args.to) || "明天"}` : "", args.include_shared ? "含分享的" : "");
		case "add_calendar_event":
			return join(str(args.title), shortTime(args.start));
		case "create_schedule":
			return join(str(args.name), ON_LABEL[str(args.on)] ?? (str(args.time) || shortTime(args.at)));
		case "read_skill":
			return str(args.name);
		case "speak":
			return str(args.text).replace(/\s+/g, " ").slice(0, 60);
		case "schedule_followup":
			return join(str(args.label) || str(args.note).slice(0, 30), `${str(args.minutes)} 分鐘後`);
		case "delete_schedule":
			return str(args.id);
		case "notify":
			return join(str(args.title), str(args.text));
		case "update_memory": {
			const added = str(args.new_text).replace(/^[-*]\s*/, "");
			if (!str(args.old_text)) return `+ ${added}`;
			return added ? `${str(args.old_text).replace(/^[-*]\s*/, "")} → ${added}` : `− ${str(args.old_text).replace(/^[-*]\s*/, "")}`;
		}
		case "device_info":
		case "get_location":
		case "read_sensors":
		case "list_calendars":
		case "list_schedules":
			return "";
		default:
			return undefined;
	}
}

/** One line describing a tool call: the command, path, or API route. */
function callLabel(name: string, args: Record<string, unknown>): string {
	const phone = phoneLabel(name, args);
	if (phone !== undefined) return phone;
	if (name === "github_api") return `${args.method ?? "GET"} ${args.path ?? ""}`;
	if (name === "github_read_file") return `${args.owner}/${args.repo}/${args.path ?? ""}`;
	if (name === "web_search" && typeof args.query === "string") return args.query;
	if (name === "web_fetch" && typeof args.url === "string") return args.url;
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
	// pi prints a shell call as its prompt and the command: `$ ls -la`.
	if (name === "bash") return "$";
	if (name === "github_api") return "github";
	if (name === "github_read_file") return "github read";
	if (name === "device_info") return "device";
	if (name === "codemode") return "script";
	if (name === "web_search") return "search";
	if (name === "web_fetch") return "fetch";
	if (name === "get_location") return "location";
	if (name === "read_sensors") return "sensors";
	if (name === "get_travel_time") return "route";
	if (name === "read_calendar_events") return "calendar";
	if (name === "list_calendars") return "calendars";
	if (name === "add_calendar_event") return "calendar add";
	if (name === "create_schedule") return "schedule";
	if (name === "list_schedules") return "schedules";
	if (name === "delete_schedule") return "schedule delete";
	if (name === "schedule_followup") return "follow-up";
	if (name === "set_alarm") return "alarm";
	if (name === "set_timer") return "timer";
	if (name === "compose_email") return "email";
	if (name === "compose_sms") return "sms";
	if (name === "open_maps") return "maps";
	if (name === "open_link") return "open";
	if (name === "update_memory") return "memory";
	if (name === "read_skill") return "skill";
	return name;
}

/** Seconds since this component mounted while `running`, updated every second. */
function useElapsed(running: boolean): number {
	const [started] = useState(() => Date.now());
	const [now, setNow] = useState(started);
	useEffect(() => {
		if (!running) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [running]);
	return Math.floor((now - started) / 1000);
}

/**
 * How much output a collapsed box shows, as pi's renderers do: the last 5 lines of a shell command or script (its
 * newest output), nothing of a file read, and the first 10 lines of anything else.
 */
function preview(name: string, lines: string[]): { shown: string[]; hidden: number } {
	// pi shows nothing of a collapsed read, not even a count; tapping still opens it.
	if (name === "read") return { shown: [], hidden: 0 };
	if (name === "bash" || name === "codemode") return { shown: lines.slice(-5), hidden: Math.max(0, lines.length - 5) };
	return { shown: lines.slice(0, 10), hidden: Math.max(0, lines.length - 10) };
}

/** One tool call as pi's tool box: a full-width block tinted by status, the call on top and its output below. */
function StepRow({ call, state, prefs }: { call: Call; state: CallState | undefined; prefs: Prefs }) {
	const [open, setOpen] = useState(prefs.expandTools);
	const output = state && state.status !== "pending" ? state.output?.replace(harnessTag, "").trim() : undefined;
	// The user said no in an approval: their decision, not a failure.
	const declined = state?.status === "done" && state.isError && /\b(user|The user) declined\b/.test(output ?? "");
	const status = declined ? "declined" : tone(state);
	const images = state?.status === "done" ? state.images : [];
	const openFile = useContext(OpenFileContext);
	const elapsed = useElapsed(status === "running");
	const filePath = ["read", "write", "edit"].includes(call.name) && typeof call.arguments.path === "string" ? call.arguments.path : undefined;
	const lines = output ? output.split("\n") : [];
	// Errors show in full, as pi does; a declined approval says so in the header instead.
	const { shown, hidden } = open || status === "error" ? { shown: lines, hidden: 0 } : declined ? { shown: [], hidden: 0 } : preview(call.name, lines);
	const script = call.name === "codemode" && typeof call.arguments.code === "string" ? call.arguments.code : undefined;
	// Collapsed boxes also stop at that many lines on screen, as pi's previews count wrapped lines: a phone wraps a lot.
	const tail = call.name === "bash" || call.name === "codemode";
	const expandable = lines.length > 0 || Boolean(script);
	return (
		<div className={`step ${status}${open ? " open" : ""}`} data-tool={call.name}>
			{openFile && filePath && status !== "running" ? (
				<button type="button" className="step-open" onClick={() => openFile(filePath)} aria-label="開啟檔案">
					<FileIcon size={14} />
				</button>
			) : null}
			<button type="button" className="step-body" onClick={() => setOpen(!open)} aria-expanded={open} disabled={!expandable}>
				<span className="step-head">
					<span className="step-name">{toolName(call.name)}</span>
					<span className="step-label">{callLabel(call.name, call.arguments)}</span>
					{status === "running" && elapsed >= 3 ? <span className="step-elapsed">{elapsed}s</span> : null}
					{status === "running" ? <span className="block-cursor" aria-label="執行中" /> : null}
					{status === "error" ? <span className="step-status">失敗</span> : null}
					{status === "declined" ? <span className="step-status">已拒絕</span> : null}
				</span>
				{open && script ? <span className="step-script">{script}</span> : null}
				{shown.length > 0 ? (
					<span className={`step-output${open || status === "error" ? "" : tail ? " clamp-end" : " clamp"}`}>{shown.join("\n")}</span>
				) : null}
				{hidden > 0 ? (
					<span className="step-more">
						… {call.name === "bash" || call.name === "codemode" ? "前面" : "還有"} {hidden} 行，點一下展開
					</span>
				) : null}
			</button>
			{images.map((image, index) => (
				<button type="button" className="step-image" key={index} onClick={() => filePath && openFile?.(filePath)}>
					<img src={`data:${image.mimeType};base64,${image.data}`} alt={filePath ?? ""} />
				</button>
			))}
		</div>
	);
}

/** Consecutive tool calls, stacked like pi's tool boxes. */
function Steps({ group, calls, prefs }: { group: Call[]; calls: CallStates; prefs: Prefs }) {
	return (
		<div className="steps">
			{group.map((call) => (
				<StepRow key={call.id} call={call} state={calls.get(call.id)} prefs={prefs} />
			))}
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

// The diagram renderer is about 2 MB: loaded the first time an answer has a diagram, not at launch.
const Mermaid = lazy(() => import("./Mermaid.tsx"));

/**
 * Fenced code with a language label and a copy button. A finished answer's mermaid block is drawn as a diagram, with
 * a switch to its source; while streaming it stays source, since half a diagram does not parse.
 */
function CodeBlock({ children, diagrams }: ComponentProps<"pre"> & { diagrams?: boolean }) {
	const [copied, setCopied] = useState(false);
	const [showSource, setShowSource] = useState(false);
	const code = (children as { props?: { className?: string; children?: unknown } } | undefined)?.props;
	const language = /language-(\S+)/.exec(code?.className ?? "")?.[1] ?? "";
	const source = String(code?.children ?? "").replace(/\n$/, "");
	const pre = <pre>{children}</pre>;
	const diagram = diagrams && language === "mermaid";
	return (
		<div className="code">
			<div className="code-head">
				<span>{language || "text"}</span>
				{diagram ? (
					<button type="button" onClick={() => setShowSource(!showSource)}>
						{showSource ? "圖表" : "原始碼"}
					</button>
				) : null}
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
			{diagram && !showSource ? (
				<Suspense fallback={<div className="diagram-loading" />}>
					<Mermaid source={source} fallback={pre} />
				</Suspense>
			) : (
				pre
			)}
		</div>
	);
}

/** Tables scroll sideways inside a frame instead of squeezing their columns to the screen. */
function Table(props: ComponentProps<"table">) {
	return (
		<div className="table">
			<table {...props} />
		</div>
	);
}

export const markdownComponents = { pre: (props: ComponentProps<"pre">) => <CodeBlock {...props} diagrams />, table: Table };
/** For text still arriving: no diagrams yet. */
export const streamingMarkdownComponents = { pre: CodeBlock, table: Table };
// CJK-friendly emphasis: CommonMark misses **粗體**是 when the closing ** follows CJK punctuation.
export const remarkPlugins = [remarkGfm, remarkCjkFriendly, remarkBreaks];

/**
 * Text a model sometimes emits instead of an answer: a stray mode tag, or a tool call written out as text (which runs
 * nothing). Not shown; the chat offers a retry when that is all an answer has.
 */
const BROKEN_TEXT = /^\s*(<thinking_mode>[^<]*<\/thinking_mode>\s*|<invoke name=[\s\S]*|<function_calls>[\s\S]*)$/;

export function isBrokenText(text: string): boolean {
	return BROKEN_TEXT.test(text);
}

/** A finished answer with nothing to show: no tool call and no text beyond what isBrokenText hides. */
export function isEmptyAnswer(entry: EntryRecord): boolean {
	const model = message(entry);
	if (entry.kind !== "pi.assistant" || model?.role !== "assistant") return false;
	if (model.stopReason === "error" || model.stopReason === "aborted") return false;
	return !blocks(model.content).some(
		(block) => block.type === "toolCall" || (block.type === "text" && block.text.trim() && !isBrokenText(block.text)),
	);
}

function Content({ content, prefs, calls, streaming }: { content: readonly Block[]; prefs: Prefs; calls: CallStates; streaming?: boolean }) {
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
	// Text written before a tool call in the same message narrates the work, not the answer; it is shown quietly.
	const lastCall = content.findLastIndex((block) => block.type === "toolCall");
	return (
		<>
			{groups.map((group, index) => {
				if (Array.isArray(group)) {
					return <Steps key={index} group={group} calls={calls} prefs={prefs} />;
				}
				switch (group.type) {
					case "text": {
						const attachment = parseAttachment(group.text);
						if (attachment) return <AttachmentChip key={index} card={attachment} />;
						if (isCodeNote(group.text)) return null;
						if (!streaming && isBrokenText(group.text)) return null;
						return (
							<div
								className={`markdown${content.indexOf(group) < lastCall ? " interim" : ""}${streaming && content[lastText] === group ? " caret" : ""}`}
								key={index}
							>
								{streaming && content[lastText] === group ? (
									<StreamingMarkdown text={group.text} />
								) : (
									<Markdown remarkPlugins={remarkPlugins} components={markdownComponents}>
										{group.text}
									</Markdown>
								)}
							</div>
						);
					}
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

export function StreamingAnswer({
	content,
	prefs,
	calls,
	answerRef,
}: {
	content: Block[];
	prefs: Prefs;
	calls: CallStates;
	/** The answer's element, which grows every frame while it streams (streaming.tsx). */
	answerRef?: (element: HTMLElement | null) => void;
}) {
	return (
		<article className="answer streaming" ref={answerRef}>
			<Content content={content} prefs={prefs} calls={calls} streaming />
		</article>
	);
}

/** An input a schedule or a follow-up sent: who sent it and when; the instruction folds to two lines. */
function TriggerInput({ id, data }: { id: string; data: Static<typeof TriggerEntryData> }) {
	const [open, setOpen] = useState(false);
	const time = data.at === undefined ? undefined : new Date(data.at);
	const clock = time ? ` · ${time.getMonth() + 1}/${time.getDate()} ${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}` : "";
	return (
		<section className="trigger-entry" data-entry={id}>
			<div className="trigger-head">
				{data.kind === "followup" ? "稍後再看" : "排程"} · {data.name}
				{data.device ? ` · ${/^(開始|連上|到了|離開)/.test(data.device) ? data.device : `戴上 ${data.device}`}` : ""}
				{clock}
				{DELIVERY[data.delivery] ?? ""}
			</div>
			{data.kind === "followup" ? null : (
				<button type="button" className={`trigger-prompt${open ? " open" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open}>
					{data.prompt}
				</button>
			)}
		</section>
	);
}

/**
 * One entry of the transcript. Memoized: Chat re-renders on every keystroke in the composer and every streamed token,
 * and redrawing every answer then (Markdown parsing included) made typing take 30 to 40 ms a key on the S24 in a
 * 27-entry conversation, growing with the conversation. Its props change only when the entry does.
 */
export const EntryView = memo(function EntryView({
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
	// Long press on the user's own message opens its actions, like a context menu. Not on answers: there it is Android's
	// text selection, which taking the long press cut short at the first character.
	const longPress = {
		onContextMenu: (event: { preventDefault: () => void }) => {
			event.preventDefault();
			onActions(entry);
		},
	};
	if (entry.kind === "pi.compaction") return <div className="divider">較早的對話已壓縮成摘要</div>;
	if (entry.kind === "pi.reset") return <div className="divider">新的上下文</div>;
	if (entry.kind === TRIGGER_ENTRY && Value.Check(TriggerEntryData, entry.data)) {
		return <TriggerInput id={String(entry.id)} data={entry.data} />;
	}
	if (!model) return null;
	if (entry.kind === "pi.user" && model.role === "user") {
		return (
			<section className="prompt" data-entry={String(entry.id)} {...longPress} onClick={() => onActions(entry)}>
				<div className="bubble">
					<Content content={blocks(model.content)} prefs={prefs} calls={calls} />
				</div>
			</section>
		);
	}
	if (entry.kind === "pi.assistant" && model.role === "assistant") {
		const aborted = model.stopReason === "aborted";
		return (
			<article className={`answer${aborted ? " aborted" : ""}`}>
				<Content content={blocks(model.content)} prefs={prefs} calls={calls} />
				{aborted ? <div className="note">已中斷</div> : null}
				{model.errorMessage && !aborted ? <div className="note error">{model.errorMessage}</div> : null}
			</article>
		);
	}
	// Tool results render inside the trace of the call that produced them.
	return null;
});
