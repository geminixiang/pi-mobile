import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BusyMode, ConversationController, ConversationId, SubmissionId } from "../agent/runtime.ts";
import { Composer, type QueuedItem } from "./Composer.tsx";
import { type Block, type CallState, EntryView, entryText, finishedCalls, StreamingAnswer } from "./Message.tsx";
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

function suggestions(capabilities: Capabilities): string[] {
	return [
		"這支手機現在幾點、在哪個時區？",
		...(capabilities.github ? ["我最近在 GitHub 上動過哪些 repo？"] : []),
		...(capabilities.sandbox ? ["在 sandbox 用 Python 算出 1 到 100 的質數"] : []),
		"幫我看這張圖（先附上圖片）",
	];
}

export function Chat({
	controller,
	prefs,
	capabilities,
	initialDraft,
	onOpenConversation,
	onError,
	onView,
}: {
	controller: ConversationController;
	prefs: Prefs;
	capabilities: Capabilities;
	initialDraft?: string;
	onOpenConversation: (id: ConversationId, draft: string) => void;
	onError: (message: string) => void;
	onView?: (view: ConversationView) => void;
}) {
	const [view, setView] = useState<ConversationView>();
	const [draft, setDraft] = useState(initialDraft ?? "");
	const [actionsFor, setActionsFor] = useState<EntryRecord>();
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

	return (
		<div className="chat">
			<div
				className="transcript"
				ref={scroller}
				onScroll={(event) => {
					const element = event.currentTarget;
					stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
				}}
			>
				{empty ? (
					<div className="empty">
						<div className="empty-mark">pi</div>
						<p>放在口袋裡的 agent。對話、金鑰都只在這支手機上。</p>
						<div className="suggestions">
							{suggestions(capabilities).map((suggestion) => (
								<button type="button" key={suggestion} onClick={() => setDraft(suggestion)}>
									{suggestion}
								</button>
							))}
						</div>
					</div>
				) : null}
				{entries.map((entry) => (
					<EntryView key={String(entry.id)} entry={entry} prefs={prefs} calls={calls} onActions={setActionsFor} />
				))}
				{partial ? <StreamingAnswer content={partial} prefs={prefs} calls={calls} /> : null}
				{live?.compactions?.length ? <div className="working">壓縮對話中</div> : null}
				{busy && !partial && !running ? <div className="working">思考中</div> : null}
				{live?.generation?.retry ? <div className="note error">重試中：{live.generation.retry.error}</div> : null}
			</div>
			<Composer
				busy={busy}
				draft={draft}
				onDraftChange={setDraft}
				queued={queued}
				onSend={(content, whenBusy) => {
					stickToBottom.current = true;
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
			/>

			{actionsFor ? (
				<Sheet onClose={() => setActionsFor(undefined)}>
					<div className="menu">
						<button
							type="button"
							onClick={async () => {
								await navigator.clipboard.writeText(entryText(actionsFor)).catch(fail);
								setActionsFor(undefined);
							}}
						>
							複製
						</button>
						{actionsFor.kind === "pi.user" ? (
							<button
								type="button"
								onClick={async () => {
									setActionsFor(undefined);
									try {
										const fork = await controller.forkBefore(actionsFor.id);
										onOpenConversation(fork.id, fork.text);
									} catch (error) {
										fail(error);
									}
								}}
							>
								從這裡分支
								<span className="menu-hint">開新對話，保留之前的內容，這則訊息放回輸入框</span>
							</button>
						) : null}
					</div>
				</Sheet>
			) : null}
		</div>
	);
}
