import type { ImageContent } from "@earendil-works/pi-ai";
import { useRef, useState } from "react";
import type { BusyMode, SubmissionId, UserContent } from "../agent/runtime.ts";
import { CloseIcon, ImageIcon, SendIcon, StopIcon } from "./icons.tsx";

const MAX_IMAGE_EDGE = 1600;

/** Downscale a photo to a JPEG that fits the model's image limits and keeps requests small. */
async function toImageContent(file: File): Promise<ImageContent> {
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
	onSend,
	onStop,
	onWithdraw,
}: {
	busy: boolean;
	draft: string;
	onDraftChange: (text: string) => void;
	queued: QueuedItem[];
	onSend: (content: UserContent, whenBusy: BusyMode) => void;
	onStop: () => void;
	onWithdraw: (id: SubmissionId) => void;
}) {
	const [images, setImages] = useState<ImageContent[]>([]);
	const fileInput = useRef<HTMLInputElement>(null);
	const hasInput = draft.trim() !== "" || images.length > 0;

	const send = (whenBusy: BusyMode) => {
		if (!hasInput) return;
		const trimmed = draft.trim();
		onSend([...(trimmed ? [{ type: "text" as const, text: trimmed }] : []), ...images], whenBusy);
		onDraftChange("");
		setImages([]);
	};

	return (
		<div className="composer">
			{queued.length > 0 ? (
				<ul className="queue">
					{queued.map((item) => (
						<li key={String(item.id)}>
							<span className="queue-mode">{item.mode === "steer" ? "插話" : "稍後"}</span>
							<span className="queue-text">{item.text || "（圖片）"}</span>
							<button type="button" className="icon-button small" aria-label="撤回" onClick={() => onWithdraw(item.id)}>
								<CloseIcon />
							</button>
						</li>
					))}
				</ul>
			) : null}
			<div className="capsule">
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
							</button>
						))}
					</div>
				) : null}
				<div className="capsule-row">
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
						}}
					/>
					<textarea
						rows={1}
						value={draft}
						placeholder={busy ? "插話，或排一個下一步" : "要做什麼？"}
						onChange={(event) => onDraftChange(event.target.value)}
					/>
					{!busy ? (
						<button type="button" className="send" onClick={() => send("steer")} disabled={!hasInput} aria-label="送出">
							<SendIcon />
						</button>
					) : hasInput ? (
						<div className="busy-actions">
							<button type="button" className="pill accent" onClick={() => send("steer")}>
								插話
							</button>
							<button type="button" className="pill" onClick={() => send("followUp")}>
								稍後
							</button>
						</div>
					) : (
						<button type="button" className="send stop" onClick={onStop} aria-label="停止">
							<StopIcon />
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
