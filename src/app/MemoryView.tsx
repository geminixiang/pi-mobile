// The MEMORY.md page: what pi knows about the user in every conversation. The user edits it here; the agent edits it
// with update_memory, and a change it makes while the page is open shows up unless the user has unsaved edits.
import { useEffect, useRef, useState } from "react";
import type { Memory } from "../agent/memory.ts";
import { MEMORY_LIMIT } from "../agent/memory.ts";
import type { AgentRuntime } from "../agent/runtime.ts";
import { BackIcon } from "./icons.tsx";

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
	return `${memory.updatedBy === "agent" ? "pi" : "你"}在 ${time} 更新`;
}

export function MemoryView({ runtime, onClose, onError }: { runtime: AgentRuntime; onClose: () => void; onError: (message: string) => void }) {
	const [saved, setSaved] = useState<Memory>();
	const [draft, setDraft] = useState<string>();
	const [saving, setSaving] = useState(false);
	const savedText = useRef<string>(undefined);
	useEffect(
		() =>
			runtime.subscribeMemory((memory) => {
				// Take the agent's change unless the user is in the middle of an edit.
				const previous = savedText.current;
				setDraft((current) => (current === undefined || current.trim() === previous ? memory.text : current));
				savedText.current = memory.text;
				setSaved(memory);
			}),
		[runtime],
	);
	const text = draft ?? "";
	const changed = saved !== undefined && text.trim() !== saved.text;
	const over = text.trim().length > MEMORY_LIMIT;

	return (
		<div className="screen memory">
			<header className="bar">
				<button type="button" className="icon-button" onClick={onClose} aria-label="返回">
					<BackIcon />
				</button>
				<h1 className="bar-heading">記憶</h1>
				<button
					type="button"
					className="btn primary"
					disabled={!changed || over || saving}
					onClick={() => {
						setSaving(true);
						runtime
							.saveMemory(text)
							.then(() => setDraft(text.trim()))
							.catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))
							.finally(() => setSaving(false));
					}}
				>
					儲存
				</button>
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
					placeholder={PLACEHOLDER}
					onChange={(event) => setDraft(event.target.value)}
					spellCheck={false}
					aria-label="MEMORY.md"
				/>
				<p className="memory-hint">
					pi 在每個對話都會讀這份筆記；你提到家在哪、喜歡什麼時，它也會自己記下來。
					<br />
					{saved?.updatedAt ? (
						<>
							{when(saved)}。
							<br />
						</>
					) : null}
					內容每次都會送到模型服務，不要放密碼或金鑰。
				</p>
			</div>
		</div>
	);
}
