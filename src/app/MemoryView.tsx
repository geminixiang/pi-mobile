import { useEffect, useRef, useState } from "react";
import type { Memory, MemoryScope } from "../agent/memory.ts";
import { MEMORY_LIMIT } from "../agent/memory.ts";
import type { AgentRuntime } from "../agent/runtime.ts";
import { messageOf } from "../promise.ts";
import { BackButton } from "./BackButton.tsx";
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

export function MemoryView({
	runtime,
	scope,
	botName,
	onClose,
	onError,
}: {
	runtime: AgentRuntime;
	scope: MemoryScope;
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
				const previous = savedText.current;
				setDraft((current) => (current === undefined || current.trim() === previous ? memory.text : current));
				savedText.current = memory.text;
				setSaved(memory);
			}),
		[runtime, scope.kind, scope.kind === "bot" ? scope.id : undefined],
	);
	const text = draft ?? "";
	const changed = saved !== undefined && text.trim() !== saved.text;
	const over = text.trim().length > MEMORY_LIMIT;
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
			runtime.saveMemory(scope, last).catch((error: unknown) => onError(messageOf(error)));
		},
		[],
	);

	return (
		<div className="screen memory">
			<header className="bar">
				<BackButton onClick={onClose} />
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
							{saved.updatedBy === "agent" ? "Bot" : "你"}在 {monthDayTime(saved.updatedAt)} 更新
						</>
					) : null}
				</p>
			</div>
		</div>
	);
}
