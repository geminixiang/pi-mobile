import { contentText, type ImageContent } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { type ComponentProps, isValidElement, lazy, memo, Suspense, useContext, useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkGfm from "remark-gfm";
import { ChevronIcon, CloseIcon, FileIcon, TriggerIcon, type TriggerSymbol } from "./icons.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { isWhenKind, triggerSymbol } from "../triggers/when.ts";
import { type AttachmentCard, parseAttachment } from "../agent/attachments.ts";
import { type Block, blocks, message } from "../agent/entries.ts";
import { isCodeNote } from "../agent/codes.ts";
import type { Prefs } from "./prefs.ts";
import { StreamingMarkdown } from "./streaming.tsx";
import { OpenFileContext } from "./openFile.ts";
import { triggerRun, type TriggerRun } from "../triggers/runs.ts";
import { formatBytes, monthDayTime } from "../agent/tools/common.ts";

const DELIVERY: Record<string, string> = { live: "", later: " · 打開後執行", manual: " · 手動執行" };

export type CallState =
	| { status: "pending" }
	| { status: "running"; output?: string }
	| { status: "done"; isError: boolean; output: string; images: ImageContent[] };

type CallStates = ReadonlyMap<string, CallState>;

export function finishedCalls(entries: readonly EntryRecord[]): Map<string, CallState> {
	const calls = new Map<string, CallState>();
	for (const entry of entries) {
		const result = message(entry);
		if (result?.role !== "toolResult") continue;
		const output = contentText(result.content);
		const images = result.content.filter((block) => block.type === "image");
		calls.set(result.toolCallId, { status: "done", isError: result.isError, output, images });
	}
	return calls;
}

const KIND_LABEL: Record<AttachmentCard["kind"], string> = { pdf: "PDF", docx: "Word", sheet: "試算表", text: "文字" };

export function AttachmentChip({ card, status, onRemove }: { card: Pick<AttachmentCard, "name" | "kind" | "size" | "pages">; status?: string; onRemove?: () => void }) {
	const detail = status ?? [KIND_LABEL[card.kind], card.pages ? `${card.pages} 頁` : "", formatBytes(card.size)].filter(Boolean).join(" · ");
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

const ON_LABEL: Record<string, string> = { headphones: "戴上耳機時", charging: "開始充電時", wifi: "連上 Wi‑Fi 時", arrive: "到達時", leave: "離開時" };

const str = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");
const join = (...parts: string[]): string => parts.filter(Boolean).join(" · ");

function shortTime(value: unknown): string {
	const match = /^\d{4}-(\d{2})-(\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(str(value));
	return match ? `${Number(match[1])}/${Number(match[2])}${match[3] ? ` ${match[3]}` : ""}` : str(value);
}

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
			return str(args.path) || str(args.title) || str(args.text).slice(0, 40);
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

function callLabel(name: string, args: Record<string, unknown>): string {
	const phone = phoneLabel(name, args);
	if (phone !== undefined) return phone;
	if (name === "github_api") return `${args.method ?? "GET"} ${args.path ?? ""}`;
	if (name === "github_read_file") return `${args.owner}/${args.repo}/${args.path ?? ""}`;
	if (name === "web_search" && typeof args.query === "string") return args.query;
	if (name === "web_fetch" && typeof args.url === "string") return typeof args.save_to === "string" && args.save_to ? `${args.url} → ${args.save_to}` : args.url;
	if (name === "bash" && typeof args.command === "string") return args.command;
	if (name === "codemode" && typeof args.code === "string") {
		return args.code.split("\n").find((line) => line.trim() && !line.trim().startsWith("//"))?.trim() ?? "";
	}
	if (typeof args.path === "string") return args.path;
	const json = JSON.stringify(args);
	return json === "{}" ? "" : json;
}

const harnessTag = /<\/?harness>\n?/g;

type Call = Extract<Block, { type: "toolCall" }>;

const TOOL_NAMES = new Map<string, string>([
	["bash", "$"],
	["github_api", "github"],
	["github_read_file", "github read"],
	["device_info", "device"],
	["codemode", "script"],
	["web_search", "search"],
	["web_fetch", "fetch"],
	["get_location", "location"],
	["read_sensors", "sensors"],
	["get_travel_time", "route"],
	["read_calendar_events", "calendar"],
	["list_calendars", "calendars"],
	["add_calendar_event", "calendar add"],
	["create_schedule", "schedule"],
	["list_schedules", "schedules"],
	["delete_schedule", "schedule delete"],
	["schedule_followup", "follow-up"],
	["set_alarm", "alarm"],
	["set_timer", "timer"],
	["compose_email", "email"],
	["compose_sms", "sms"],
	["open_maps", "maps"],
	["open_link", "open"],
	["update_memory", "memory"],
	["read_skill", "skill"],
]);

const toolName = (name: string) => TOOL_NAMES.get(name) ?? name;

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

function preview(name: string, lines: string[]): { shown: string[]; hidden: number } {
	if (name === "read") return { shown: [], hidden: 0 };
	if (name === "bash" || name === "codemode") return { shown: lines.slice(-5), hidden: Math.max(0, lines.length - 5) };
	return { shown: lines.slice(0, 10), hidden: Math.max(0, lines.length - 10) };
}

const HTML_PATH = /(?:^|[\s"'`(])((?:\/|\.\/)?[^\s"'`()<>]+\.html?)(?=$|[\s"'`),.:;，。])/gim;

function htmlPathsIn(output: string | undefined): string[] {
	if (!output) return [];
	const found = new Set<string>();
	for (const match of output.matchAll(HTML_PATH)) if (match[1]) found.add(match[1]);
	return [...found];
}

function StepRow({ call, state, prefs }: { call: Call; state: CallState | undefined; prefs: Prefs }) {
	const [open, setOpen] = useState(prefs.expandTools);
	const output = state && state.status !== "pending" ? state.output?.replace(harnessTag, "").trim() : undefined;
	const status = state?.status !== "done" ? "running" : state.isError ? "error" : "ok";
	const images = state?.status === "done" ? state.images : [];
	const openFile = useContext(OpenFileContext);
	const elapsed = useElapsed(status === "running");
	const filePath = ["read", "write", "edit"].includes(call.name) && typeof call.arguments.path === "string" ? call.arguments.path : undefined;
	const openable = filePath ? [filePath] : call.name === "codemode" || call.name === "bash" ? htmlPathsIn(output) : [];
	const lines = output ? output.split("\n") : [];
	const { shown, hidden } = open || status === "error" ? { shown: lines, hidden: 0 } : preview(call.name, lines);
	const script = call.name === "codemode" && typeof call.arguments.code === "string" ? call.arguments.code : undefined;
	const tail = call.name === "bash" || call.name === "codemode";
	const expandable = lines.length > 0 || Boolean(script);
	return (
		<div className={`step ${status}${open ? " open" : ""}`} data-tool={call.name}>
			<button type="button" className="step-body" onClick={() => setOpen(!open)} aria-expanded={open} disabled={!expandable}>
				<span className="step-head">
					<span className="step-name">{toolName(call.name)}</span>
					<span className="step-label">{callLabel(call.name, call.arguments)}</span>
					{status === "running" && elapsed >= 3 ? <span className="step-elapsed">{elapsed}s</span> : null}
					{status === "running" ? <span className="block-cursor" aria-label="執行中" /> : null}
					{status === "error" ? <span className="step-status">失敗</span> : null}
				</span>
				{open && script ? <span className="step-script">{script}</span> : null}
				{shown.length > 0 ? (
					<span className={`step-output${open || status === "error" ? "" : tail ? " clamp-end" : " clamp"}`}>{shown.join("\n")}</span>
				) : null}
				{hidden > 0 ? (
					<span className="step-more">
						… {tail ? "前面" : "還有"} {hidden} 行
					</span>
				) : null}
			</button>
			{openFile && status !== "running" && openable[0] ? (
				<button type="button" className="step-open" onClick={() => openFile(openable[0])} aria-label={`開啟 ${openable[0].split("/").at(-1) ?? "檔案"}`}>
					<FileIcon size={14} />
				</button>
			) : null}
			{images.map((image, index) => (
				<button type="button" className="step-image" key={index} onClick={() => filePath && openFile?.(filePath)}>
					<img src={`data:${image.mimeType};base64,${image.data}`} alt={filePath ?? ""} />
				</button>
			))}
		</div>
	);
}

function Thinking({ text, streaming }: { text: string; streaming?: boolean }) {
	const [open, setOpen] = useState(false);
	const preview = text.trim().split("\n")[0] ?? "";
	return (
		<div className="thinking">
			<button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>
				<span className="thinking-label">{streaming ? "思考中" : "思考"}</span>
				{!open ? <span className="thinking-preview">{preview}</span> : null}
				<ChevronIcon open={open} size={12} />
			</button>
			{open ? <div className="thinking-body">{text.trim()}</div> : null}
		</div>
	);
}

const Mermaid = lazy(() => import("./Mermaid.tsx"));

function CodeBlock({ children, diagrams }: ComponentProps<"pre"> & { diagrams?: boolean }) {
	const [showSource, setShowSource] = useState(false);
	const code = isValidElement<{ className?: string; children?: unknown }>(children) ? children.props : undefined;
	const language = /language-(\S+)/.exec(code?.className ?? "")?.[1] ?? "";
	const source = String(code?.children ?? "").replace(/\n$/, "");
	const pre = <pre>{children}</pre>;
	const diagram = diagrams && language === "mermaid";
	return (
		<div className="code">
			<div className="code-head">
				<span>{language || "text"}</span>
				{diagram ? (
					<button type="button" className="code-toggle" onClick={() => setShowSource(!showSource)}>
						{showSource ? "圖表" : "原始碼"}
					</button>
				) : null}
				<CopyButton text={source} className="code-copy" />
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

function Table(props: ComponentProps<"table">) {
	return (
		<div className="table">
			<table {...props} />
		</div>
	);
}

const ENCODED = /%[0-9a-f]{2}/i;

function Link({ href, children, ...props }: ComponentProps<"a">) {
	const openFile = useContext(OpenFileContext);
	return (
		<a
			{...props}
			href={href}
			onClick={(event) => {
				if (!href || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return;
				event.preventDefault();
				openFile?.(ENCODED.test(href) ? decodeURIComponent(href) : href);
			}}
		>
			{children}
		</a>
	);
}

export const markdownComponents = { pre: (props: ComponentProps<"pre">) => <CodeBlock {...props} diagrams />, table: Table, a: Link };
export const streamingMarkdownComponents = { pre: CodeBlock, table: Table, a: Link };
export const remarkPlugins = [remarkGfm, remarkCjkFriendly, remarkBreaks];

const BROKEN_TEXT = /^\s*(<thinking_mode>[^<]*<\/thinking_mode>\s*|<invoke name=[\s\S]*|<function_calls>[\s\S]*)$/;

export function isEmptyAnswer(entry: EntryRecord): boolean {
	const model = message(entry);
	if (entry.kind !== "pi.assistant" || model?.role !== "assistant") return false;
	if (model.stopReason === "error" || model.stopReason === "aborted") return false;
	return !blocks(model.content).some(
		(block) => block.type === "toolCall" || (block.type === "text" && block.text.trim() && !BROKEN_TEXT.test(block.text)),
	);
}

export function Content({ content, prefs, calls, streaming }: { content: readonly Block[]; prefs: Prefs; calls: CallStates; streaming?: boolean }) {
	const groups: (Block | Call[])[] = [];
	for (const block of content) {
		const last = groups.at(-1);
		if (block.type === "toolCall") {
			if (Array.isArray(last)) last.push(block);
			else groups.push([block]);
		} else groups.push(block);
	}
	const lastText = content.findLastIndex((block) => block.type === "text");
	const lastCall = content.findLastIndex((block) => block.type === "toolCall");
	return (
		<>
			{groups.map((group, index) => {
				if (Array.isArray(group)) {
					return (
						<div className="steps" key={index}>
							{group.map((call) => (
								<StepRow key={call.id} call={call} state={calls.get(call.id)} prefs={prefs} />
							))}
						</div>
					);
				}
				switch (group.type) {
					case "text": {
						const attachment = parseAttachment(group.text);
						if (attachment) return <AttachmentChip key={index} card={attachment} />;
						if (isCodeNote(group.text)) return null;
						if (!streaming && BROKEN_TEXT.test(group.text)) return null;
						const caret = streaming && content[lastText] === group;
						return (
							<div
								className={`markdown${content.indexOf(group) < lastCall ? " interim" : ""}${caret ? " caret" : ""}`}
								key={index}
							>
								{caret ? (
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


function entrySymbol(data: TriggerRun): TriggerSymbol {
	if (data.on && isWhenKind(data.on)) return triggerSymbol({ kind: data.on, ...(data.activity ? { activity: data.activity } : {}) });
	if (data.kind === "followup" || !data.device) return "clock";
	if (data.device.startsWith("開始充電")) return "charging";
	if (data.device.startsWith("連上")) return "wifi";
	if (/^(到了|離開)/.test(data.device)) return "pin";
	if (data.device.startsWith("收到")) return "bell";
	return "headphones";
}

function TriggerInput({ id, data }: { id: string; data: TriggerRun }) {
	const [open, setOpen] = useState(false);
	const symbol = entrySymbol(data);
	const clock = data.at === undefined ? "" : ` · ${monthDayTime(data.at)}`;
	return (
		<section className="trigger-entry" data-entry={id}>
			<div className="trigger-head">
				<TriggerIcon symbol={symbol} size={13} />
				{data.kind === "followup" ? `稍後再看：${data.name}` : data.name}
				{data.device ? ` · ${symbol === "headphones" ? `戴上 ${data.device}` : data.device}` : ""}
				{data.judged !== undefined ? ` · 判斷 ${Math.round(data.judged * 100)}%` : ""}
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

function sameCall(before: CallState | undefined, after: CallState | undefined): boolean {
	if (before === after) return true;
	if (!before || !after || before.status !== after.status) return false;
	if (before.status === "pending") return true;
	if (before.status === "running") return after.status === "running" && before.output === after.output;
	return (
		after.status === "done" &&
		before.isError === after.isError &&
		before.output === after.output &&
		before.images.length === after.images.length &&
		before.images.every((image, index) => image.data === after.images[index]?.data)
	);
}

function sameCallsFor(entry: EntryRecord, before: CallStates, after: CallStates): boolean {
	if (before === after) return true;
	const content = message(entry)?.content;
	if (!Array.isArray(content)) return true;
	for (const block of content) {
		if (block.type === "toolCall" && !sameCall(before.get(block.id), after.get(block.id))) return false;
	}
	return true;
}

type EntryViewProps = {
	entry: EntryRecord;
	prefs: Prefs;
	calls: CallStates;
	onActions: (entry: EntryRecord) => void;
};

function sameEntryView(before: EntryViewProps, after: EntryViewProps): boolean {
	return (
		before.entry === after.entry &&
		before.prefs === after.prefs &&
		before.onActions === after.onActions &&
		sameCallsFor(after.entry, before.calls, after.calls)
	);
}

export const EntryView = memo(function EntryView({
	entry,
	prefs,
	calls,
	onActions,
}: EntryViewProps) {
	const model = message(entry);
	if (entry.kind === "pi.compaction") return <div className="divider">較早的對話已壓縮成摘要</div>;
	if (entry.kind === "pi.reset") return <div className="divider">新的上下文</div>;
	const run = triggerRun(entry);
	if (run) return <TriggerInput id={String(entry.id)} data={run} />;
	if (!model) return null;
	if (entry.kind === "pi.user" && model.role === "user") {
		return (
			<section className="prompt" data-entry={String(entry.id)} onContextMenu={(event) => {
					event.preventDefault();
					onActions(entry);
				}}
				onClick={() => onActions(entry)}>
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
	return null;
}, sameEntryView);
