import { useEffect, useState } from "react";
import { AVATARS, avatarOf, type Bot, freeAvatar, MAX_JOB } from "../agent/bots.ts";
import { MemoryIcon, TrashIcon } from "./icons.tsx";
import { Sheet } from "./Sheet.tsx";
import { showToast } from "./Toasts.tsx";

export type BotEdit = { kind: "create" } | { kind: "edit"; bot: Bot };

const JOB_PLACEHOLDER = `例如：
每天整理我的行程和待辦，早上 8 點給我簡報。
寄信、改行程前先問我。`;

export function BotSheet({
	edit,
	bots,
	canDelete,
	onSave,
	onMemory,
	onDelete,
	onClose,
}: {
	edit: BotEdit | undefined;
	bots: readonly Bot[];
	canDelete: boolean;
	onSave: (change: { name: string; job: string; avatar: string }) => Promise<void>;
	onMemory: (bot: Bot) => void;
	onDelete: (bot: Bot) => void;
	onClose: () => void;
}) {
	const [name, setName] = useState("");
	const [job, setJob] = useState("");
	const [avatar, setAvatar] = useState<string>(AVATARS[0].id);
	const [saving, setSaving] = useState(false);
	useEffect(() => {
		if (!edit) return;
		setName(edit.kind === "edit" ? edit.bot.name : "");
		setJob(edit.kind === "edit" ? edit.bot.job : "");
		setAvatar(edit.kind === "edit" ? avatarOf(edit.bot) : freeAvatar(bots));
		setSaving(false);
	}, [edit]);
	const bot = edit?.kind === "edit" ? edit.bot : undefined;
	const changed = !bot || name.trim() !== bot.name || job.trim() !== bot.job || avatar !== avatarOf(bot);
	const valid = Boolean(name.trim()) && job.length <= MAX_JOB;
	const leave = (next: () => void) => () => {
		if (bot && changed) {
			if (valid) void onSave({ name, job, avatar });
			else showToast(name.trim() ? `工作說明超過 ${MAX_JOB} 字，沒有儲存` : "沒有名字，沒有儲存");
		}
		next();
	};
	return (
		<Sheet open={Boolean(edit)} title={bot ? `${bot.name} 的設定` : "新增 Bot"} onClose={leave(onClose)}>
			<form
				className="bot-form"
				onSubmit={(event) => {
					event.preventDefault();
					if (bot) return;
					setSaving(true);
					void onSave({ name, job, avatar }).finally(() => setSaving(false));
				}}
			>
				<div className="avatar-picker" role="radiogroup" aria-label="頭像">
					{AVATARS.map((option) => (
						<button
							type="button"
							key={option.id}
							role="radio"
							aria-checked={avatar === option.id}
							aria-label={option.label}
							className={avatar === option.id ? "selected" : ""}
							onClick={() => setAvatar(option.id)}
						>
							<img src={`/avatars/${option.id}.webp`} alt="" draggable={false} />
						</button>
					))}
				</div>
				<label>
					<span>名字</span>
					<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：秘書、研究員" autoComplete="off" />
				</label>
				<label>
					<span>
						工作
						<em className={`bot-count${job.length > MAX_JOB ? " over" : ""}`}>
							{job.length} / {MAX_JOB}
						</em>
					</span>
					<textarea value={job} onChange={(event) => setJob(event.target.value)} placeholder={JOB_PLACEHOLDER} rows={5} />
				</label>
				{bot ? null : (
					<div className="row-buttons">
						<button type="submit" className="btn primary" disabled={!valid || saving}>
							建立
						</button>
					</div>
				)}
			</form>
			{bot ? (
				<div className="menu">
					<button type="button" onClick={leave(() => onMemory(bot))}>
						<MemoryIcon />
						<span className="menu-text">{bot.name} 的記憶</span>
					</button>
					{canDelete ? (
						<button type="button" className="danger" onClick={() => onDelete(bot)}>
							<TrashIcon size={18} />
							<span className="menu-text">刪除 Bot</span>
						</button>
					) : null}
				</div>
			) : null}
		</Sheet>
	);
}
