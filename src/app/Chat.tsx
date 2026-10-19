import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BusyMode, ConversationController, ConversationId, SubmissionId } from "../agent/runtime.ts";
import { Composer, type QueuedItem } from "./Composer.tsx";
import { ArrowIcon, BranchIcon, ChevronDownIcon, CopyIcon } from "./icons.tsx";
import { type Block, type CallState, EntryView, entryText, finishedCalls, StreamingAnswer } from "./Message.tsx";
import { PiMark } from "./PiMark.tsx";
import type { Prefs } from "./prefs.ts";
import { Sheet } from "./Sheet.tsx";

interface LiveState {
	run?: unknown;
	generation?: { message?: { content?: Block[] }; retry?: { at: number; error: string } };
	tools?: { callId: string; name: string; status: "pending" | "running" | "done"; output?: string }[];
	compactions?: unknown[];
}

interface InboxState {
	items: { id: SubmissionId; mode: BusyMode | "write"; content: unknown }[];
}

export interface Capabilities {
	github: boolean;
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

function suggestions(capabilities: Capabilities): Suggestion[] {
	return [
		...(capabilities.sandbox ? [{ title: "跑一段程式", prompt: "在 sandbox 用 Python 算出 1 到 100 的質數" }] : []),
		...(capabilities.github ? [{ title: "看看 GitHub", prompt: "我最近在 GitHub 上動過哪些 repo？" }] : []),
		{ title: "看一張圖", prompt: "幫我看看這張圖裡有什麼", image: true },
		{ title: "問這支手機", prompt: "這支手機現在幾點、在哪個時區？" },
	].slice(0, 4);
}

/** Whether the agent is working in this view. */
export function isBusy(view: ConversationView | undefined): boolean {
	return Boolean((view?.docs["pi.live"] as LiveState | undefined)?.run);
}

export function Chat({
	controller,
	prefs,
	capabilities,
	initialDraft,
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

	const live = view?.docs["pi.live"] as LiveState | undefined;
	const inbox = view?.docs["pi.inbox"] as InboxState | undefined;
	const busy = Boolean(live?.run);
	const partial = live?.generation?.message?.content;
	const entries = view?.entries ?? [];

	const calls = useMemo(() => {
		const states: Map<string, CallState> = finishedCalls(entries);
		for (const tool of live?.tools ?? []) {
			if (!states.has(tool.callId)) states.set(tool.callId, { status: tool.status, output: tool.output });
		}
		return states;
	}, [entries, live?.tools]);

	const queued: QueuedItem[] = (inbox?.items ?? []).flatMap((item) =>
		item.mode === "write" ? [] : [{ id: item.id, mode: item.mode, text: text(item.content) }],
	);
	const running = (live?.tools ?? []).some((tool) => tool.status !== "done");
	const fail = (error: unknown) => onError(error instanceof Error ? error.message : String(error));
	const empty = view !== undefined && !entries.some((entry) => entry.kind === "pi.user");
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
				{empty ? (
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
