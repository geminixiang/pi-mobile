import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ConversationController } from "../agent/runtime.ts";
import { TRIGGER_ENTRY, triggerRun } from "../agent/triggers.ts";
import { parseAttachment } from "../agent/attachments.ts";
import { isCodeNote } from "../agent/codes.ts";
import { Composer, type QueuedItem } from "./Composer.tsx";
import type { DialPrompt } from "./PromptDial.tsx";
import { ArrowIcon, CopyIcon, RefreshIcon } from "./icons.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { type CallState, EntryView, entryText, finishedCalls, isEmptyAnswer, StreamingAnswer } from "./Message.tsx";
import { inboxOf, liveOf } from "./docs.ts";
import { PiMark } from "./PiMark.tsx";
import { TranscriptSkeleton } from "./Skeleton.tsx";
import type { Prefs } from "./prefs.ts";
import { Sheet } from "./Sheet.tsx";
import { loadDraftText, saveDraftText } from "./drafts.ts";
import { messageOf } from "../promise.ts";
import { haptic } from "./haptics.ts";
import { inApp, type NativePlugin } from "../native.ts";

interface Capabilities {
	native: ReadonlySet<NativePlugin>;
	sandbox: boolean;
}

function text(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: { type: string; text?: string }) => {
			if (part.type !== "text" || !part.text) return "";
			if (isCodeNote(part.text)) return "";
			const attachment = parseAttachment(part.text);
			return attachment ? `［${attachment.name}］` : part.text;
		})
		.join(" ");
}

interface Suggestion {
	title: string;
	prompt: string;
	image?: boolean;
}

export type SharedKind = "image" | "file" | "text" | "screen";

function SuggestionList({ items, onPick }: { items: readonly Suggestion[]; onPick: (item: Suggestion) => void }) {
	return (
		<ol className="suggestions">
			{items.map((item, index) => (
				<li key={item.title}>
					<button type="button" onClick={() => onPick(item)}>
						<span className="suggestion-index">{String(index + 1).padStart(2, "0")}</span>
						<span className="suggestion-text">
							<strong>{item.title}</strong>
							<span>{item.prompt}</span>
						</span>
						<ArrowIcon />
					</button>
				</li>
			))}
		</ol>
	);
}

function shareActions(kind: SharedKind): Suggestion[] {
	if (kind === "screen") {
		return [
			{ title: "這頁在講什麼", prompt: "這個畫面在講什麼？用幾句話說重點" },
			{ title: "幫我回覆", prompt: "幫我想一個回覆，簡短、口語" },
			{ title: "接下來要做什麼", prompt: "看這個畫面，我接下來要做什麼？有日期或待辦就幫我排進行事曆" },
		];
	}
	if (kind === "file") {
		return [
			{ title: "摘要", prompt: "讀一下這份檔案，用幾點摘要重點" },
			{ title: "找出要注意的", prompt: "這份檔案裡有哪些日期、金額或要我做的事？" },
			{ title: "翻譯", prompt: "翻成繁體中文" },
		];
	}
	return kind === "image"
		? [
				{ title: "這是什麼", prompt: "這張圖裡有什麼？" },
				{ title: "抄下文字", prompt: "把圖裡的文字抄下來，不是中文的話翻成中文" },
				{ title: "排進行事曆", prompt: "如果這是活動或行程，幫我加到行事曆" },
			]
		: [
				{ title: "摘要", prompt: "讀一下這個，用幾點摘要重點" },
				{ title: "翻譯", prompt: "翻成繁體中文" },
				{ title: "晚點提醒我", prompt: "今晚 9 點提醒我看這個，附上一句摘要" },
			];
}

function suggestions(capabilities: Capabilities): Suggestion[] {
	return [
		{ title: "比較後做成表格", prompt: "比較 iPhone 17 和 Pixel 11 現在的售價、相機和電池，整理成表格檔傳給我" },
		...(capabilities.native.has("Triggers") && capabilities.native.has("Phone") ? [{ title: "每天早上報天氣", prompt: "每天早上七點告訴我今天要不要帶傘、穿多少" }] : []),
		...(capabilities.native.has("Calendar") ? [{ title: "找時間約吃飯", prompt: "看看我這週的行程，哪幾天晚上有空可以約朋友吃飯" }] : []),
		...(capabilities.native.has("Database") ? [{ title: "拍收據記帳", prompt: "幫我把這張收據記進帳本，之後問這個月花多少要算得出來", image: true }] : []),
		...(capabilities.sandbox ? [{ title: "畫一張圖表", prompt: "在電腦上用 Python 畫一張台灣六都人口的長條圖給我看" }] : []),
	];
}

export interface Notice {
	id: number;
	text: string;
}

export function isBusy(view: ConversationView | undefined): boolean {
	return Boolean(liveOf(view)?.run);
}

export function Chat({
	controller,
	prefs,
	capabilities,
	initialDraft,
	initialFiles,
	shared,
	focusKey,
	notices,
	onDismissNotices,
	onError,
	onView,
}: {
	controller: ConversationController;
	prefs: Prefs;
	capabilities: Capabilities;
	initialDraft?: string;
	initialFiles?: readonly File[];
	shared?: SharedKind;
	focusKey: number;
	notices: readonly Notice[];
	onDismissNotices: (ids: readonly number[]) => void;
	onError: (message: string) => void;
	onView?: (view: ConversationView) => void;
}) {
	const [view, setView] = useState<ConversationView>();
	const conversationId = String(controller.id);
	const [draft, setDraft] = useState(() => [loadDraftText(conversationId), initialDraft].filter(Boolean).join("\n\n"));
	useEffect(() => saveDraftText(conversationId, draft), [conversationId, draft]);
	const [actionsFor, setActionsFor] = useState<EntryRecord>();
	const [atBottom, setAtBottom] = useState(true);
	const [composerFocus, setComposerFocus] = useState(0);
	const [pickImage, setPickImage] = useState(0);
	const scroller = useRef<HTMLDivElement>(null);
	const stickToBottom = useRef(true);

	useEffect(
		() =>
			controller.subscribe((next) => {
				setView(next);
				onView?.(next);
			}),
		[controller, onView],
	);

	useEffect(() => {
		if (focusKey || initialDraft) setComposerFocus((key) => key + 1);
	}, [focusKey, initialDraft]);

	useLayoutEffect(() => {
		const element = scroller.current;
		if (element && stickToBottom.current) element.scrollTop = element.scrollHeight;
	});
	const chat = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const box = chat.current;
		const composer = box?.querySelector<HTMLElement>(":scope > .composer");
		const transcript = scroller.current;
		if (!box || !composer || !transcript) return;
		const observer = new ResizeObserver(() => {
			box.style.setProperty("--composer-h", `${composer.offsetHeight}px`);
			if (stickToBottom.current) transcript.scrollTop = transcript.scrollHeight;
		});
		observer.observe(composer);
		observer.observe(transcript);
		return () => observer.disconnect();
	}, []);
	const streamObserver = useRef<ResizeObserver>(undefined);
	const followStream = useMemo(
		() => (element: HTMLElement | null) => {
			streamObserver.current?.disconnect();
			if (!element) return;
			streamObserver.current = new ResizeObserver(() => {
				const box = scroller.current;
				if (box && stickToBottom.current) box.scrollTop = box.scrollHeight;
			});
			streamObserver.current.observe(element);
		},
		[],
	);

	const live = liveOf(view);
	const inbox = inboxOf(view);
	const busy = Boolean(live?.run);
	const partial = live?.generation?.message?.content;
	const entries = view?.entries ?? [];

	const calls = useMemo(() => {
		const states: Map<string, CallState> = finishedCalls(entries);
		for (const tool of live?.tools ?? []) {
			if (states.has(tool.callId)) continue;
			states.set(tool.callId, tool.status === "pending" ? { status: "pending" } : { status: "running", output: tool.output });
		}
		return states;
	}, [entries, live?.tools]);

	const queued: QueuedItem[] = (inbox?.items ?? []).flatMap((item) =>
		item.mode === "write" ? [] : [{ id: item.id, mode: item.mode, text: text(item.content) }],
	);
	const running = (live?.tools ?? []).some((tool) => tool.status !== "done");
	const fail = (error: unknown) => onError(messageOf(error));
	const empty = view !== undefined && !entries.some((entry) => entry.kind === "pi.user" || entry.kind === TRIGGER_ENTRY);
	const lastEntry = entries.at(-1);
	const lastAnswer = lastEntry?.kind === "pi.assistant" && entryText(lastEntry).trim() && !isEmptyAnswer(lastEntry) ? lastEntry : undefined;
	const emptyAnswer = !busy && lastEntry !== undefined && isEmptyAnswer(lastEntry);
	const contentSize = entries.length * 1_000_000 + JSON.stringify(partial ?? "").length;
	const sizeWhenLeft = useRef(contentSize);
	useEffect(() => {
		if (atBottom) sizeWhenLeft.current = contentSize;
	}, [atBottom, contentSize]);
	const scrollHint = atBottom ? undefined : contentSize > sizeWhenLeft.current ? "new" : "latest";
	const scrollToBottom = () => {
		stickToBottom.current = true;
		scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
	};
	const prompts: DialPrompt[] = useMemo(
		() =>
			entries.flatMap((entry) => {
				if (entry.kind === "pi.user") {
					const typed = text(entry.model?.[0]?.content).replace(/\s+/g, " ").trim();
					return [{ id: String(entry.id), text: typed || "（圖片）" }];
				}
				const run = triggerRun(entry);
				if (run) {
					return [{ id: String(entry.id), text: `自動化：${run.name}` }];
				}
				return [];
			}),
		[entries],
	);
	const jumpTo = (id: string | undefined) => {
		if (id === undefined) {
			scrollToBottom();
			return;
		}
		const element = scroller.current?.querySelector<HTMLElement>(`[data-entry="${CSS.escape(id)}"]`);
		if (!element) return;
		stickToBottom.current = false;
		element.scrollIntoView({ block: "start", behavior: "smooth" });
		element.classList.remove("flash");
		void element.offsetWidth;
		element.classList.add("flash");
	};

	return (
		<div className="chat" ref={chat}>
			<div
				className="transcript"
				ref={scroller}
				onScroll={(event) => {
					const element = event.currentTarget;
					const bottom = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
					stickToBottom.current = bottom;
					setAtBottom(bottom);
				}}
			>
				{view === undefined ? <TranscriptSkeleton /> : null}
				{empty && shared ? (
					<div className="empty">
						<PiMark size={36} />
						<h2>
							要 pi 怎麼<em>處理</em>？
						</h2>
						<SuggestionList
							items={shareActions(shared)}
							onPick={(action) => {
								setDraft((current) => (current.trim() ? `${action.prompt}\n\n${current.trim()}` : action.prompt));
								setComposerFocus((key) => key + 1);
							}}
						/>
					</div>
				) : empty ? (
					<div className="empty">
						<PiMark size={36} />
						<h2>
							口袋裡的 agent，
							<br />
							只屬於<em>你</em>。
						</h2>
						<p>對話、金鑰和紀錄都只存在{inApp ? "這支手機上" : "這個瀏覽器裡"}。</p>
						<SuggestionList
							items={suggestions(capabilities)}
							onPick={(suggestion) => {
								setDraft(suggestion.prompt);
								if (suggestion.image) setPickImage((key) => key + 1);
								else setComposerFocus((key) => key + 1);
							}}
						/>
					</div>
				) : null}
				{entries.map((entry) => (
					<EntryView key={String(entry.id)} entry={entry} prefs={prefs} calls={calls} onActions={setActionsFor} />
				))}
				{lastAnswer && !busy ? (
					<div className="answer-actions">
						<CopyButton text={entryText(lastAnswer)} />
					</div>
				) : null}
				{emptyAnswer ? (
					<div className="answer-actions">
						<span className="note">沒有回答</span>
						<button
							type="button"
							className="icon-button small"
							aria-label="再試一次"
							onClick={() => {
								stickToBottom.current = true;
								controller
									.send([{ type: "text", text: "（上一則沒有產生回答，請重新處理我上一個要求）" }])
									.catch(fail);
							}}
						>
							<RefreshIcon size={16} />
						</button>
					</div>
				) : null}
				{partial ? <StreamingAnswer content={partial} prefs={prefs} calls={calls} answerRef={followStream} /> : null}
				{live?.compactions?.length ? <Working label="壓縮對話中" /> : null}
				{busy && !partial && !running ? <Working label="思考中" /> : null}
				{live?.generation?.retry ? <div className="note error">重試中：{live.generation.retry.error}</div> : null}
				{notices.map((notice) => (
					<button type="button" key={notice.id} className="note error notice" onClick={() => onDismissNotices([notice.id])}>
						{notice.text}
					</button>
				))}
			</div>
			<Composer
				scrollHint={scrollHint}
				onScrollToBottom={scrollToBottom}
				prompts={prompts}
				onJump={jumpTo}
				busy={busy}
				draft={draft}
				onDraftChange={setDraft}
				queued={queued}
				focusKey={composerFocus}
				pickImageKey={pickImage}
				conversationId={conversationId}
				initialFiles={initialFiles}
				onSend={(content, whenBusy) => {
					stickToBottom.current = true;
					if (notices.length > 0) onDismissNotices(notices.map((notice) => notice.id));
					setAtBottom(true);
					controller.send(content, whenBusy).catch(fail);
				}}
				onStop={async () => {
					try {
						const returned = await controller.stop();
						if (returned.length > 0) setDraft((current) => [...returned, current].filter(Boolean).join("\n\n"));
					} catch (error) {
						fail(error);
					}
				}}
				onWithdraw={(id) => controller.withdraw(id).catch(fail)}
			/>

			<Sheet open={Boolean(actionsFor)} title={actionsFor?.kind === "pi.user" ? "你的訊息" : "回答"} onClose={() => setActionsFor(undefined)}>
				<div className="menu">
					<button
						type="button"
						onClick={async () => {
							const entry = actionsFor;
							setActionsFor(undefined);
							if (entry) await navigator.clipboard.writeText(entryText(entry)).then(() => haptic("confirm"), fail);
						}}
					>
						<CopyIcon size={18} />
						<span className="menu-text">複製文字</span>
					</button>
				</div>
			</Sheet>
		</div>
	);
}

function Working({ label }: { label: string }) {
	return (
		<div className="working">
			<span className="block-cursor" aria-hidden="true" />
			{label}
		</div>
	);
}
