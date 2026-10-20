import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BusyMode, ConversationController, ConversationId, SubmissionId } from "../agent/runtime.ts";
import type { ImageContent } from "@earendil-works/pi-ai";
import { TRIGGER_ENTRY } from "../agent/triggers.ts";
import { Composer, type QueuedItem } from "./Composer.tsx";
import { ArrowIcon, BranchIcon, ChevronDownIcon, CopyIcon } from "./icons.tsx";
import { type Block, type CallState, EntryView, entryText, finishedCalls, isEmptyAnswer, StreamingAnswer } from "./Message.tsx";
import { inboxOf, liveOf } from "./docs.ts";
import { PiMark } from "./PiMark.tsx";
import type { Prefs } from "./prefs.ts";
import { Sheet } from "./Sheet.tsx";

export interface Capabilities {
	sandbox: boolean;
}

function text(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part: { type: string; text?: string }) => (part.type === "text" ? part.text : "")).join(" ");
}

interface Suggestion {
	title: string;
	prompt: string;
	/** Opens the photo picker as well, for prompts that need an image. */
	image?: boolean;
}

/** What to do with something shared from another app; picked, it goes before the shared text in the composer. */
function shareActions(kind: "image" | "text"): Suggestion[] {
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
		{ title: "帶我去喝咖啡", prompt: "找一間我附近評價好的咖啡廳，開地圖帶我走過去" },
		{ title: "煮麵計時", prompt: "我要煮義大利麵，查一下一般要煮幾分鐘，然後幫我設計時器" },
		{ title: "排進行事曆", prompt: "下週六早上十點去爬象山，幫我加到行事曆，備註提醒我帶水" },
		...(capabilities.sandbox
			? [{ title: "畫一張圖表", prompt: "在 sandbox 用 Python 畫一張台灣六都人口的長條圖給我看" }]
			: [{ title: "看一張圖", prompt: "幫我看看這張圖裡有什麼", image: true }]),
	];
}

/** Whether the agent is working in this view. */
export function isBusy(view: ConversationView | undefined): boolean {
	return Boolean(liveOf(view)?.run);
}

export function Chat({
	controller,
	prefs,
	capabilities,
	initialDraft,
	initialImages,
	shared,
	focusKey,
	onOpenConversation,
	onError,
	onNotice,
	onView,
}: {
	controller: ConversationController;
	prefs: Prefs;
	capabilities: Capabilities;
	initialDraft?: string;
	initialImages?: ImageContent[];
	/** Opened with something shared from another app: suggest what to do with it instead of the general examples. */
	shared?: "image" | "text";
	/** Changes when the composer should take focus, such as after starting a new conversation. */
	focusKey: number;
	onOpenConversation: (id: ConversationId, draft: string) => void;
	onError: (message: string) => void;
	onNotice: (message: string) => void;
	onView?: (view: ConversationView) => void;
}) {
	const [view, setView] = useState<ConversationView>();
	const [draft, setDraft] = useState(initialDraft ?? "");
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

	// Follow new output only while the user is at the bottom, so scrolling back to read is not interrupted.
	useLayoutEffect(() => {
		const element = scroller.current;
		if (element && stickToBottom.current) element.scrollTop = element.scrollHeight;
	});

	const live = liveOf(view);
	const inbox = inboxOf(view);
	const busy = Boolean(live?.run);
	const partial = live?.generation?.message?.content;
	const entries = view?.entries ?? [];

	const calls = useMemo(() => {
		const states: Map<string, CallState> = finishedCalls(entries);
		for (const tool of live?.tools ?? []) {
			if (states.has(tool.callId)) continue;
			// A slot reaches "done" before its result entry arrives; show it as running until then.
			states.set(tool.callId, tool.status === "pending" ? { status: "pending" } : { status: "running", output: tool.output });
		}
		return states;
	}, [entries, live?.tools]);

	const queued: QueuedItem[] = (inbox?.items ?? []).flatMap((item) =>
		item.mode === "write" ? [] : [{ id: item.id, mode: item.mode, text: text(item.content) }],
	);
	const running = (live?.tools ?? []).some((tool) => tool.status !== "done");
	const fail = (error: unknown) => onError(error instanceof Error ? error.message : String(error));
	const empty = view !== undefined && !entries.some((entry) => entry.kind === "pi.user" || entry.kind === TRIGGER_ENTRY);
	// The run's final answer: the last entry when it is an assistant message with text.
	const lastEntry = entries.at(-1);
	const lastAnswer = lastEntry?.kind === "pi.assistant" && entryText(lastEntry).trim() && !isEmptyAnswer(lastEntry) ? lastEntry : undefined;
	const emptyAnswer = !busy && lastEntry !== undefined && isEmptyAnswer(lastEntry);
	const scrollToBottom = () => {
		stickToBottom.current = true;
		scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
	};

	return (
		<div className="chat">
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
				{empty && shared ? (
					<div className="empty">
						<PiMark size={36} />
						<h2>
							要 pi 怎麼<em>處理</em>？
						</h2>
						<p>{shared === "image" ? "圖片已經放在輸入框裡。" : "分享的內容已經放在輸入框裡。"}選一個，或直接打字說要做什麼。</p>
						<ol className="suggestions">
							{shareActions(shared).map((action, index) => (
								<li key={action.title}>
									<button
										type="button"
										onClick={() => {
											setDraft((current) => (current.trim() ? `${action.prompt}\n\n${current.trim()}` : action.prompt));
											setComposerFocus((key) => key + 1);
										}}
									>
										<span className="suggestion-index">{String(index + 1).padStart(2, "0")}</span>
										<span className="suggestion-text">
											<strong>{action.title}</strong>
											<span>{action.prompt}</span>
										</span>
										<ArrowIcon />
									</button>
								</li>
							))}
						</ol>
					</div>
				) : empty ? (
					<div className="empty">
						<PiMark size={36} />
						<h2>
							口袋裡的 agent，
							<br />
							只屬於<em>你</em>。
						</h2>
						<p>對話、金鑰和紀錄都只存在這支手機上。</p>
						<div className="strip-label">試試看</div>
						<ol className="suggestions">
							{suggestions(capabilities).map((suggestion, index) => (
								<li key={suggestion.title}>
									<button
										type="button"
										onClick={() => {
											setDraft(suggestion.prompt);
											if (suggestion.image) setPickImage((key) => key + 1);
											else setComposerFocus((key) => key + 1);
										}}
									>
										<span className="suggestion-index">{String(index + 1).padStart(2, "0")}</span>
										<span className="suggestion-text">
											<strong>{suggestion.title}</strong>
											<span>{suggestion.prompt}</span>
										</span>
										<ArrowIcon />
									</button>
								</li>
							))}
						</ol>
					</div>
				) : null}
				{entries.map((entry) => (
					<EntryView key={String(entry.id)} entry={entry} prefs={prefs} calls={calls} onActions={setActionsFor} />
				))}
				{lastAnswer && !busy ? (
					<div className="answer-actions">
						<button
							type="button"
							className="btn"
							onClick={() => void navigator.clipboard.writeText(entryText(lastAnswer)).then(() => onNotice("已複製回答"), fail)}
						>
							複製回答
						</button>
					</div>
				) : null}
				{emptyAnswer ? (
					<div className="answer-actions">
						<span className="note">這次沒有產生回答，模型服務偶爾會這樣。</span>
						<button
							type="button"
							className="btn"
							onClick={() => {
								stickToBottom.current = true;
								controller
									.send([{ type: "text", text: "（上一則沒有產生回答，請重新處理我上一個要求）" }])
									.catch(fail);
							}}
						>
							再試一次
						</button>
					</div>
				) : null}
				{partial ? <StreamingAnswer content={partial} prefs={prefs} calls={calls} /> : null}
				{live?.compactions?.length ? <Working label="壓縮對話中" /> : null}
				{busy && !partial && !running ? <Working label="思考中" /> : null}
				{live?.generation?.retry ? <div className="note error">重試中：{live.generation.retry.error}</div> : null}
			</div>
			{!atBottom ? (
				<button type="button" className="to-bottom" onClick={scrollToBottom} aria-label="捲到最新">
					<ChevronDownIcon />
				</button>
			) : null}
			<Composer
				busy={busy}
				draft={draft}
				onDraftChange={setDraft}
				queued={queued}
				focusKey={composerFocus}
				pickImageKey={pickImage}
				initialImages={initialImages}
				onSend={(content, whenBusy) => {
					stickToBottom.current = true;
					setAtBottom(true);
					controller.send(content, whenBusy).catch(fail);
				}}
				onStop={async () => {
					try {
						// Like pi: stopping returns queued messages to the editor.
						const returned = await controller.stop();
						if (returned.length > 0) setDraft((current) => [...returned, current].filter(Boolean).join("\n\n"));
					} catch (error) {
						fail(error);
					}
				}}
				onWithdraw={(id) => controller.withdraw(id).catch(fail)}
				onNotice={onNotice}
			/>

			<Sheet open={Boolean(actionsFor)} title={actionsFor?.kind === "pi.user" ? "你的訊息" : "回答"} onClose={() => setActionsFor(undefined)}>
				<div className="menu">
					<button
						type="button"
						onClick={async () => {
							const entry = actionsFor;
							setActionsFor(undefined);
							if (entry) await navigator.clipboard.writeText(entryText(entry)).then(() => onNotice("已複製"), fail);
						}}
					>
						<CopyIcon size={18} />
						<span className="menu-text">複製文字</span>
					</button>
					{actionsFor?.kind === "pi.user" ? (
						<button
							type="button"
							onClick={async () => {
								const entry = actionsFor;
								setActionsFor(undefined);
								try {
									const fork = await controller.forkBefore(entry.id);
									onOpenConversation(fork.id, fork.text);
									onNotice("已開新分支，訊息放回輸入框");
								} catch (error) {
									fail(error);
								}
							}}
						>
							<BranchIcon />
							<span className="menu-text">
								從這裡分支
								<span className="menu-hint">開一個新對話，保留這之前的內容，這則訊息放回輸入框讓你改寫</span>
							</span>
						</button>
					) : null}
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
