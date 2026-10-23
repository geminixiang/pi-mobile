// A MEMORY.md page: the global one, what every bot knows about the user, or one bot's notes for its job. The user
// edits it here, and the edits are saved when the page goes away (back, the gesture, closing): there is no save button.
// The agent edits it with update_memory; a change it makes while the page is open shows up unless the user has edits.
import { useEffect, useRef, useState } from "react";
import type { Memory, MemoryScope } from "../agent/memory.ts";
import { MEMORY_LIMIT } from "../agent/memory.ts";
import type { AgentRuntime } from "../agent/runtime.ts";
import { BackIcon } from "./icons.tsx";

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

function when(memory: Memory): string {
	if (!memory.updatedAt) return "";
	const date = new Date(memory.updatedAt);
	const time = `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
	return `${memory.updatedBy === "agent" ? "Bot" : "你"}在 ${time} 更新`;
}

export function MemoryView({
	runtime,
	scope,
	botName,
	onClose,
	onError,
}: {
	runtime: AgentRuntime;
	scope: MemoryScope;
	/** For a bot's memory: whose it is. */
	botName?: string;
	onClose: () => void;
	onError: (message: string) => void;
}) {
	const [saved, setSaved] = useState<Memory>();
	const [draft, setDraft] = useState<string>();
	const savedText = useRef<string>(undefined);
	useEffect(
		() =>
			runtime.subscribeMemory(scope, (memory) => {
				// Take the agent's change unless the user is in the middle of an edit.
				const previous = savedText.current;
				setDraft((current) => (current === undefined || current.trim() === previous ? memory.text : current));
				savedText.current = memory.text;
				setSaved(memory);
			}),
		// The scope is a fresh object on every render; what identifies it is its kind and bot.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[runtime, scope.kind, scope.kind === "bot" ? scope.id : undefined],
	);
	const text = draft ?? "";
	const changed = saved !== undefined && text.trim() !== saved.text;
	const over = text.trim().length > MEMORY_LIMIT;
	// Unmounting is the one point every way of leaving passes through; the ref holds what is on screen then.
	const leaving = useRef({ text, changed, over });
	leaving.current = { text, changed, over };
	useEffect(
		() => () => {
			const { text: last, changed: dirty, over: tooLong } = leaving.current;
			if (!dirty) return;
			if (tooLong) {
				onError(`超過 ${MEMORY_LIMIT} 字，記憶沒有儲存`);
				return;
			}
			runtime.saveMemory(scope, last).catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)));
		},
		// Once, on unmount; the latest values come from the ref.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[],
	);

	return (
		<div className="screen memory">
			<header className="bar">
				<button type="button" className="icon-button" onClick={onClose} aria-label="返回">
					<BackIcon />
				</button>
				<h1 className="bar-heading">{scope.kind === "global" ? "全域記憶" : `${botName ?? "Bot"} 的記憶`}</h1>
				<span className="bar-spacer" />
			</header>
			<div className="memory-body">
				<div className="memory-file">
					<span>MEMORY.md</span>
					<span className={over ? "over" : ""}>
						{text.trim().length} / {MEMORY_LIMIT}
					</span>
				</div>
				<textarea
					className="memory-text"
					value={text}
					placeholder={scope.kind === "global" ? PLACEHOLDER : BOT_PLACEHOLDER}
					onChange={(event) => setDraft(event.target.value)}
					spellCheck={false}
					aria-label="MEMORY.md"
				/>
				<p className="memory-hint">
					會送給模型，不要放密碼或金鑰。
					{saved?.updatedAt ? (
						<>
							<br />
							{when(saved)}
						</>
					) : null}
				</p>
			</div>
		</div>
	);
}
