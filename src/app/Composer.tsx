import type { ImageContent } from "@earendil-works/pi-ai";
import { useEffect, useRef, useState } from "react";
import type { BusyMode, SubmissionId, UserContent } from "../agent/runtime.ts";
import { CloseIcon, ImageIcon, MicIcon, SendIcon, StopIcon } from "./icons.tsx";
import { type DialPrompt, ScrollTab } from "./PromptDial.tsx";
import { useDictation } from "./voice.ts";

const MAX_IMAGE_EDGE = 1600;

/** Downscale a photo to a JPEG that fits the model's image limits and keeps requests small. */
export async function toImageContent(file: File): Promise<ImageContent> {
	const bitmap = await createImageBitmap(file);
	const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
	const canvas = document.createElement("canvas");
	canvas.width = Math.round(bitmap.width * scale);
	canvas.height = Math.round(bitmap.height * scale);
	canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	bitmap.close();
	const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
	return { type: "image", mimeType: "image/jpeg", data: dataUrl.slice(dataUrl.indexOf(",") + 1) };
}

export interface QueuedItem {
	id: SubmissionId;
	mode: BusyMode;
	text: string;
}

export function Composer({
	busy,
	draft,
	onDraftChange,
	queued,
	focusKey,
	pickImageKey,
	initialImages,
	onSend,
	onStop,
	onWithdraw,
	onNotice,
	scrollHint,
	onScrollToBottom,
	prompts,
	onJump,
}: {
	busy: boolean;
	draft: string;
	onDraftChange: (text: string) => void;
	queued: QueuedItem[];
	focusKey: number;
	pickImageKey: number;
	/** Images to start with, such as one shared from another app. */
	initialImages?: ImageContent[];
	onSend: (content: UserContent, whenBusy: BusyMode) => void;
	onStop: () => void;
	onWithdraw: (id: SubmissionId) => void;
	onNotice: (message: string) => void;
	/** Shown on the composer's top line when the transcript is scrolled up: "latest", or "new" once more arrived. */
	scrollHint?: "latest" | "new";
	onScrollToBottom: () => void;
	/** The user's messages, oldest first, for the dial. */
	prompts: DialPrompt[];
	/** Scroll to one of them, or to the newest when undefined. */
	onJump: (id: string | undefined) => void;
}) {
	const [images, setImages] = useState<ImageContent[]>(initialImages ?? []);
	const fileInput = useRef<HTMLInputElement>(null);
	const textArea = useRef<HTMLTextAreaElement>(null);
	const hasInput = draft.trim() !== "" || images.length > 0;
	const latestDraft = useRef(draft);
	latestDraft.current = draft;
	const dictation = useDictation((text) => {
		const current = latestDraft.current;
		onDraftChange(current && !/\s$/.test(current) ? `${current} ${text}` : `${current}${text}`);
		textArea.current?.focus();
	}, onNotice);
	const listening = dictation.state !== "idle";

	useEffect(() => {
		if (!focusKey) return;
		const area = textArea.current;
		area?.focus();
		area?.setSelectionRange(area.value.length, area.value.length);
	}, [focusKey]);

	useEffect(() => {
		if (pickImageKey) fileInput.current?.click();
	}, [pickImageKey]);

	const send = (whenBusy: BusyMode) => {
		if (!hasInput) return;
		const trimmed = draft.trim();
		onSend([...(trimmed ? [{ type: "text" as const, text: trimmed }] : []), ...images], whenBusy);
		onDraftChange("");
		setImages([]);
	};

	return (
		// Touches here are not side swipes (SidePanel.tsx): the scroll tab's slide opens the prompt dial.
		<div className="composer" onTouchStart={(event) => event.stopPropagation()}>
			{queued.length > 0 ? (
				<ul className="queue">
					{queued.map((item) => (
						<li key={String(item.id)}>
							<span className="queue-mode">{item.mode === "steer" ? "插話" : "稍後"} · 排隊中</span>
							<span className="queue-text">{item.text || "（圖片）"}</span>
							<button type="button" className="icon-button small" aria-label="撤回" onClick={() => onWithdraw(item.id)}>
								<CloseIcon />
							</button>
						</li>
					))}
				</ul>
			) : null}
			<div className="input">
				{/* A tab on the editor's line, as pi writes "↓ N more" into it; a long press opens the prompt dial. */}
				<ScrollTab hint={scrollHint} prompts={prompts} onScrollToBottom={onScrollToBottom} onJump={onJump} />
				{images.length > 0 ? (
					<div className="pending-images">
						{images.map((image, index) => (
							<button
								type="button"
								key={index}
								className="thumb"
								onClick={() => setImages(images.filter((_, other) => other !== index))}
								aria-label="移除圖片"
							>
								<img src={`data:${image.mimeType};base64,${image.data}`} alt="" />
								<span className="thumb-remove">
									<CloseIcon size={12} />
								</span>
							</button>
						))}
					</div>
				) : null}
				{listening ? (
					<div className="dictation" aria-live="polite">
						<span className="dictation-meter" aria-hidden="true">
							{[0.15, 0.35, 0.55, 0.75, 0.95].map((threshold) => (
								<i key={threshold} className={dictation.level >= threshold ? "on" : ""} />
							))}
						</span>
						<span className="dictation-text">
							{dictation.partial || (dictation.state === "starting" ? "準備中…" : "請說話…")}
						</span>
						<button type="button" className="btn" onClick={dictation.cancel}>
							取消
						</button>
						<button type="button" className="btn primary" onClick={dictation.stop}>
							完成
						</button>
					</div>
				) : null}
				<div className="input-row" hidden={listening}>
					<button type="button" className="icon-button" onClick={() => fileInput.current?.click()} aria-label="附加圖片">
						<ImageIcon />
					</button>
					<input
						ref={fileInput}
						type="file"
						accept="image/*"
						multiple
						hidden
						onChange={async (event) => {
							const files = [...(event.target.files ?? [])];
							event.target.value = "";
							const added = await Promise.all(files.map(toImageContent));
							setImages((current) => [...current, ...added]);
							textArea.current?.focus();
						}}
					/>
					<textarea
						ref={textArea}
						rows={1}
						value={draft}
						placeholder={busy ? "插話，或排一個下一步" : "問 pi"}
						onChange={(event) => onDraftChange(event.target.value)}
					/>
					{!busy && !hasInput && dictation.supported ? (
						<button type="button" className="send mic" onClick={dictation.start} aria-label="語音輸入">
							<MicIcon />
						</button>
					) : !busy ? (
						<button type="button" className="send" onClick={() => send("steer")} disabled={!hasInput} aria-label="送出">
							<SendIcon />
						</button>
					) : (
						<button type="button" className="send stop" onClick={onStop} aria-label="停止">
							<StopIcon />
						</button>
					)}
				</div>
				{busy && hasInput ? (
					<div className="busy-actions">
						<span className="busy-hint">pi 還在工作：</span>
						<button type="button" className="btn primary" onClick={() => send("steer")}>
							插話
						</button>
						<button type="button" className="btn" onClick={() => send("followUp")}>
							稍後
						</button>
					</div>
				) : null}
			</div>
		</div>
	);
}
