import { useEffect, useEffectEvent, useState } from "react";
import type { Bot } from "../agent/bots.ts";
import type { Memory, MemoryScope } from "../agent/memory.ts";
import { MEMORY_LIMIT } from "../agent/memory.ts";
import type { AgentRuntime } from "../agent/runtime.ts";
import { messageOf } from "../promise.ts";
import { BackButton } from "./BackButton.tsx";
import { BotAvatar } from "./BotAvatar.tsx";
import { monthDayTime } from "../agent/tools/common.ts";

const BOT_PLACEHOLDER = `# 這份工作
- 資料來源：
- 要通知誰：
- 做法：先列重點再細節`;

const PLACEHOLDER = `# 關於我
- 家：
- 公司：
- 常用交通：捷運、機車

# 偏好
- 回答簡短一點
- 不吃牛肉`;

type Line = { kind: "heading" | "entry"; text: string };
type Edit = { mode: "reading" } | { mode: "editing"; draft: string; problem?: string } | { mode: "saving"; draft: string };

function lineOf(line: string): Line {
	if (line.startsWith("#")) return { kind: "heading", text: line.slice(line.indexOf(" ") + 1) };
	if (line.startsWith("- ") || line.startsWith("* ")) return { kind: "entry", text: line.slice(2).trim() };
	return { kind: "entry", text: line };
}

export function MemoryView({
	runtime,
	scope,
	bot,
	onClose,
	onError,
}: {
	runtime: AgentRuntime;
	scope: MemoryScope;
	bot?: Bot;
	onClose: () => void;
	onError: (message: string) => void;
}) {
	const [saved, setSaved] = useState<Memory>();
	const [edit, setEdit] = useState<Edit>({ mode: "reading" });
	useEffect(
		() =>
			runtime.subscribeMemory(scope, (memory) => {
				setSaved(memory);
			}),
		[runtime, scope.kind, scope.kind === "bot" ? scope.id : undefined],
	);
	const text = edit.mode === "reading" ? (saved?.text ?? "") : edit.draft;
	const length = text.trim().length;
	const over = length > MEMORY_LIMIT;
	const changed = edit.mode === "editing" && edit.draft.trim() !== saved?.text;
	const finish = (draft: string) => {
		if (!changed) return setEdit({ mode: "reading" });
		setEdit({ mode: "saving", draft });
		runtime.saveMemory(scope, draft).then(
			() => setEdit({ mode: "reading" }),
			(error: unknown) => setEdit({ mode: "editing", draft, problem: messageOf(error) }),
		);
	};
	const saveOnLeave = useEffectEvent(() => {
		if (edit.mode !== "editing" || !changed) return;
		if (over) {
			onError(`超過 ${MEMORY_LIMIT} 字，記憶沒有儲存`);
			return;
		}
		runtime.saveMemory(scope, edit.draft).catch((error: unknown) => onError(messageOf(error)));
	});
	useEffect(() => () => saveOnLeave(), []);
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map(lineOf);

	return (
		<div className="screen memory">
			<header className="bar">
				<BackButton onClick={onClose} />
				<h1 className="bar-heading">
					{bot ? <BotAvatar bot={bot} size={20} /> : null}
					{scope.kind === "global" ? "全域記憶" : `${bot?.name ?? "Bot"}的記憶`}
				</h1>
				{edit.mode === "reading" ? (
					<button type="button" className="bar-verb" onClick={() => setEdit({ mode: "editing", draft: text })}>
						編輯
					</button>
				) : (
					<button type="button" className="bar-verb" disabled={edit.mode === "saving" || over} onClick={() => finish(edit.draft)}>
						完成
					</button>
				)}
			</header>
			{edit.mode === "reading" ? (
				<div className="memory-note">
					{lines.length === 0 ? (
						<button type="button" className="memory-empty" onClick={() => setEdit({ mode: "editing", draft: "" })}>
							還沒有記憶
						</button>
					) : (
						lines.map((line, index) => (
							<p key={index} className={line.kind}>
								{line.text}
							</p>
						))
					)}
				</div>
			) : (
				<textarea
					className="memory-text"
					value={edit.draft}
					readOnly={edit.mode === "saving"}
					placeholder={scope.kind === "global" ? PLACEHOLDER : BOT_PLACEHOLDER}
					onChange={(event) => setEdit({ mode: "editing", draft: event.target.value })}
					spellCheck={false}
					autoFocus
					aria-label="記憶"
				/>
			)}
			{edit.mode === "editing" && edit.problem ? <p className="memory-problem">{edit.problem}</p> : null}
			<footer className="memory-foot">
				{edit.mode === "reading" && saved?.updatedAt ? `${saved.updatedBy === "agent" ? "Bot" : "你"}在 ${monthDayTime(saved.updatedAt)} 更新 · ` : ""}
				{edit.mode === "reading" ? null : "會送給模型，不要放密碼或金鑰 · "}
				<span className={over ? "error" : ""}>
					{length} / {MEMORY_LIMIT}
				</span>
			</footer>
		</div>
	);
}
