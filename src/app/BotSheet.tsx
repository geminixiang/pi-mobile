// Creating a bot, or editing one: its name and its job, the part of its system prompt that says what it is for. From
// an existing bot also its own MEMORY.md and deleting it.
import { useEffect, useState } from "react";
import { type Bot, MAX_JOB } from "../agent/bots.ts";
import { MemoryIcon, TrashIcon } from "./icons.tsx";
import { Sheet } from "./Sheet.tsx";

export type BotEdit = { kind: "create" } | { kind: "edit"; bot: Bot };

const JOB_PLACEHOLDER = `例如：
每天整理我的行程和待辦，早上 8 點給我簡報。
寄信、改行程前先問我。`;

export function BotSheet({
	edit,
	canDelete,
	onSave,
	onMemory,
	onDelete,
	onClose,
}: {
	edit: BotEdit | undefined;
	/** The last bot cannot be deleted. */
	canDelete: boolean;
	onSave: (change: { name: string; job: string }) => Promise<void>;
	onMemory: (bot: Bot) => void;
	onDelete: (bot: Bot) => void;
	onClose: () => void;
}) {
	const [name, setName] = useState("");
	const [job, setJob] = useState("");
	const [saving, setSaving] = useState(false);
	useEffect(() => {
		if (!edit) return;
		setName(edit.kind === "edit" ? edit.bot.name : "");
		setJob(edit.kind === "edit" ? edit.bot.job : "");
		setSaving(false);
	}, [edit]);
	const bot = edit?.kind === "edit" ? edit.bot : undefined;
	const changed = !bot || name.trim() !== bot.name || job.trim() !== bot.job;
	return (
		<Sheet open={Boolean(edit)} title={bot ? `${bot.name} 的設定` : "新增 Bot"} onClose={onClose}>
			<form
				className="bot-form"
				onSubmit={(event) => {
					event.preventDefault();
					setSaving(true);
					void onSave({ name, job }).finally(() => setSaving(false));
				}}
			>
				<label>
					<span>名字</span>
					<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：秘書、研究員" autoComplete="off" />
				</label>
				<label>
					<span>
						工作
						<em className={job.length > MAX_JOB ? "over" : ""}>
							{job.length} / {MAX_JOB}
						</em>
					</span>
					<textarea value={job} onChange={(event) => setJob(event.target.value)} placeholder={JOB_PLACEHOLDER} rows={5} />
				</label>
				<p className="hint">Bot 會一直記得這段說明。每個 Bot 有自己的一條對話、記憶和排程，sandbox 裡各有一個資料夾。</p>
				<div className="row-buttons">
					<button type="submit" className="btn primary" disabled={!name.trim() || job.length > MAX_JOB || !changed || saving}>
						{bot ? "儲存" : "建立"}
					</button>
				</div>
			</form>
			{bot ? (
				<div className="menu">
					<button type="button" onClick={() => onMemory(bot)}>
						<MemoryIcon />
						<span className="menu-text">
							{bot.name} 的記憶
							<span className="menu-hint">只有這個 Bot 會讀的 MEMORY.md</span>
						</span>
					</button>
					{canDelete ? (
						<button type="button" className="danger" onClick={() => onDelete(bot)}>
							<TrashIcon size={18} />
							<span className="menu-text">
								刪除 Bot
								<span className="menu-hint">連同它的對話、記憶、排程和 sandbox 資料夾</span>
							</span>
						</button>
					) : null}
				</div>
			) : null}
		</Sheet>
	);
}
