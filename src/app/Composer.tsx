import type { ImageContent } from "@earendil-works/pi-ai";
import { useEffect, useRef, useState } from "react";
import { ATTACHMENT_ACCEPT, type AttachmentKind, attachmentKind, deleteAttachments, type PreparedAttachment, prepareAttachment } from "../agent/attachments.ts";
import { codeNote } from "../agent/codes.ts";
import type { BusyMode, SubmissionId, UserContent } from "../agent/runtime.ts";
import { Capacitor } from "@capacitor/core";
import { inboxFile, Scanner } from "../scanner-plugin.ts";
import { CameraIcon, CloseIcon, FileIcon, MicIcon, PaperclipIcon, ScanIcon, SendIcon, StopIcon } from "./icons.tsx";
import { Sheet } from "./Sheet.tsx";
import { Database } from "../database-plugin.ts";
import { AttachmentChip } from "./Message.tsx";
import { type DialPrompt, ScrollTab } from "./PromptDial.tsx";
import { useDictation } from "./voice.ts";
import { addDraftFile, loadDraftAttachments, receiveDraftFiles, saveDraftAttachments } from "./drafts.ts";
import { messageOf, orLogged } from "../promise.ts";

const MAX_IMAGE_EDGE = 1600;

function discardPrepared(prepared: PreparedAttachment): void {
	void deleteAttachments({ id: prepared.card.id });
	if (prepared.tables.length > 0) {
		void Database.execute({ statements: prepared.tables.map((table) => ({ sql: `DROP TABLE IF EXISTS "${table.replace(/"/g, '""')}"` })) });
	}
}

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

type PendingFile =
	| { key: string; state: "reading"; name: string; kind: AttachmentKind; size: number }
	| { key: string; state: "ready"; prepared: PreparedAttachment };

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
	conversationId,
	initialFiles,
	onSend,
	onStop,
	onWithdraw,
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
	conversationId: string;
	initialFiles?: readonly File[];
	onSend: (content: UserContent, whenBusy: BusyMode) => void;
	onStop: () => void;
	onWithdraw: (id: SubmissionId) => void;
	scrollHint?: "latest" | "new";
	onScrollToBottom: () => void;
	prompts: DialPrompt[];
	onJump: (id: string | undefined) => void;
}) {
	const [images, setImages] = useState<ImageContent[]>([]);
	const [files, setFiles] = useState<PendingFile[]>([]);
	const [problem, setProblem] = useState<string>();
	const [attachMenu, setAttachMenu] = useState(false);
	const fileInput = useRef<HTMLInputElement>(null);
	const cameraInput = useRef<HTMLInputElement>(null);
	const textArea = useRef<HTMLTextAreaElement>(null);
	const reading = files.some((file) => file.state === "reading");
	const hasInput = draft.trim() !== "" || images.length > 0 || files.length > 0;
	const latestDraft = useRef(draft);
	latestDraft.current = draft;
	const dictation = useDictation((text) => {
		const current = latestDraft.current;
		onDraftChange(current && !/\s$/.test(current) ? `${current} ${text}` : `${current}${text}`);
		textArea.current?.focus();
	}, setProblem);
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

	const restored = useRef(false);
	useEffect(() => {
		void orLogged(loadDraftAttachments(conversationId), "drafts.load_failed", undefined).then((saved) => {
				if (saved) {
					setImages((current) => [...saved.images, ...current]);
					setFiles((current) => [...saved.files.map((prepared) => ({ key: prepared.card.id, state: "ready" as const, prepared })), ...current]);
				}
				restored.current = true;
				if (initialFiles?.length) void attach([...initialFiles]);
			});
	}, []);
	useEffect(() => {
		if (!restored.current) return;
		const draft = { images, files: files.flatMap((file) => (file.state === "ready" ? [file.prepared] : [])) };
		void orLogged(saveDraftAttachments(conversationId, draft), "drafts.save_failed", undefined);
	}, [conversationId, images, files]);

	const unmounted = useRef(false);
	useEffect(() => {
		unmounted.current = false;
		return () => {
			unmounted.current = true;
		};
	}, []);
	useEffect(
		() => receiveDraftFiles(conversationId, (prepared) => setFiles((current) => [...current, { key: prepared.card.id, state: "ready", prepared }])),
		[conversationId],
	);
	const removedWhileReading = useRef(new Set<string>());

	const send = (whenBusy: BusyMode) => {
		if (!hasInput || reading) return;
		const trimmed = draft.trim();
		const attached = files.flatMap((file) => (file.state === "ready" ? file.prepared.content : []));
		const photos = images;
		onDraftChange("");
		setProblem(undefined);
		setImages([]);
		setFiles([]);
		void codeNote(photos, (index) => `photo ${index + 1}`).then((codes) =>
			onSend([...(trimmed ? [{ type: "text" as const, text: trimmed }] : []), ...attached, ...photos, ...(codes ? [codes] : [])], whenBusy),
		);
	};

	const scanDocument = async () => {
		setAttachMenu(false);
		setProblem(undefined);
		const scan = await Scanner.scan({}).then(
			(result) => result,
			(error: unknown): { cancelled: true } => {
				setProblem(`掃描失敗：${messageOf(error)}`);
				return { cancelled: true };
			},
		);
		if (scan.cancelled) return;
		const stamp = new Date().toLocaleString("sv-SE").slice(0, 16).replace(/[-: ]/g, "");
		await attach([await inboxFile(scan.pdf, `掃描 ${stamp}.pdf`, "application/pdf")]);
	};

	const attach = async (picked: File[]) => {
		setProblem(undefined);
		const photos = picked.filter((file) => file.type.startsWith("image/"));
		for (const file of picked) {
			if (file.type.startsWith("image/")) continue;
			const kind = attachmentKind(file);
			if (!kind) {
				setProblem(`不支援這種檔案：${file.name}（可以傳 PDF、Word、Excel、CSV 和純文字）`);
				continue;
			}
			const key = crypto.randomUUID();
			setFiles((current) => [...current, { key, state: "reading", name: file.name, kind, size: file.size }]);
			prepareAttachment(file, conversationId).then(
				(prepared) => {
					if (removedWhileReading.current.delete(key)) discardPrepared(prepared);
					else if (unmounted.current) void orLogged(addDraftFile(conversationId, prepared), "drafts.save_failed", undefined);
					else setFiles((current) => current.map((item) => (item.key === key ? { key, state: "ready", prepared } : item)));
				},
				(error: unknown) => {
					setFiles((current) => current.filter((item) => item.key !== key));
					setProblem(`讀不了 ${file.name}：${messageOf(error)}`);
				},
			);
		}
		const added = await Promise.all(photos.map(toImageContent));
		setImages((current) => [...current, ...added]);
		textArea.current?.focus();
	};

	return (
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
				<ScrollTab hint={scrollHint} prompts={prompts} onScrollToBottom={onScrollToBottom} onJump={onJump} />
				{files.length > 0 ? (
					<div className="pending-files">
						{files.map((file) => (
							<AttachmentChip
								key={file.key}
								card={file.state === "ready" ? file.prepared.card : file}
								status={file.state === "reading" ? "讀取中…" : undefined}
								onRemove={() => {
									setFiles((current) => current.filter((item) => item.key !== file.key));
									if (file.state === "ready") discardPrepared(file.prepared);
									else removedWhileReading.current.add(file.key);
								}}
							/>
						))}
					</div>
				) : null}
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
				{problem ? (
					<button type="button" className="composer-problem" onClick={() => setProblem(undefined)}>
						{problem}
					</button>
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
					<button type="button" className="icon-button" onClick={() => (Capacitor.isNativePlatform() ? setAttachMenu(true) : fileInput.current?.click())} aria-label="附加檔案或照片">
						<PaperclipIcon />
					</button>
					<Sheet open={attachMenu} title="附加" onClose={() => setAttachMenu(false)}>
						<div className="menu">
							<button
								type="button"
								onClick={() => {
									setAttachMenu(false);
									cameraInput.current?.click();
								}}
							>
								<CameraIcon />
								<span className="menu-text">拍照</span>
							</button>
							<button
								type="button"
								onClick={() => {
									setAttachMenu(false);
									fileInput.current?.click();
								}}
							>
								<FileIcon size={18} />
								<span className="menu-text">照片或檔案</span>
							</button>
							<button type="button" onClick={() => void scanDocument()}>
								<ScanIcon />
								<span className="menu-text">掃描文件</span>
							</button>
						</div>
					</Sheet>
					<input
						ref={cameraInput}
						type="file"
						accept="image/*"
						capture="environment"
						hidden
						onChange={(event) => {
							const picked = [...(event.target.files ?? [])];
							event.target.value = "";
							void attach(picked);
						}}
					/>
					<input
						ref={fileInput}
						type="file"
						accept={`image/*,${ATTACHMENT_ACCEPT}`}
						multiple
						hidden
						onChange={(event) => {
							const picked = [...(event.target.files ?? [])];
							event.target.value = "";
							void attach(picked);
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
						<button type="button" className="send" onClick={() => send("steer")} disabled={!hasInput || reading} aria-label="送出">
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
						<button type="button" className="btn primary" disabled={reading} onClick={() => send("steer")}>
							插話
						</button>
						<button type="button" className="btn" disabled={reading} onClick={() => send("followUp")}>
							稍後
						</button>
					</div>
				) : null}
			</div>
		</div>
	);
}
