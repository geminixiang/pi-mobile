import type { ConversationView } from "@earendil-works/pi-durable";
import { entryText } from "./Message.tsx";
import type { Prefs } from "./prefs.ts";
import { Sheet } from "./Sheet.tsx";
import { formatTokens, type Usage } from "./usage.ts";

export interface MenuActions {
	rename: () => void;
	compact: () => void;
	reset: () => void;
	resetSandbox?: () => void;
	copy: (text: string) => void;
}

export function ConversationMenu({
	view,
	title,
	usage,
	prefs,
	onPrefs,
	actions,
	onClose,
}: {
	view: ConversationView | undefined;
	title: string;
	usage: Usage;
	prefs: Prefs;
	onPrefs: (change: Partial<Prefs>) => void;
	actions: MenuActions;
	onClose: () => void;
}) {
	const run = (action: () => void) => () => {
		onClose();
		action();
	};
	const lastAnswer = [...(view?.entries ?? [])].reverse().find((entry) => entry.kind === "pi.assistant");

	return (
		<Sheet onClose={onClose} title={title}>
			<div className="menu">
				<button type="button" onClick={run(actions.rename)}>
					重新命名
				</button>
				<button type="button" disabled={!lastAnswer} onClick={run(() => lastAnswer && actions.copy(entryText(lastAnswer)))}>
					複製最後的回答
				</button>
				<button type="button" onClick={run(actions.compact)}>
					壓縮對話<span className="menu-hint">把較早的內容摘要起來，騰出上下文</span>
				</button>
				<button type="button" onClick={run(actions.reset)}>
					新的上下文<span className="menu-hint">模型看不到之前的訊息，紀錄保留</span>
				</button>
				{actions.resetSandbox ? (
					<button type="button" className="danger" onClick={run(actions.resetSandbox)}>
						重置 sandbox<span className="menu-hint">刪除這個對話的容器和檔案</span>
					</button>
				) : null}
			</div>
			<div className="toggles">
				<label>
					<input type="checkbox" checked={prefs.showThinking} onChange={(event) => onPrefs({ showThinking: event.target.checked })} />
					顯示思考過程
				</label>
				<label>
					<input type="checkbox" checked={prefs.expandTools} onChange={(event) => onPrefs({ expandTools: event.target.checked })} />
					預設展開工具輸出
				</label>
			</div>
			<dl className="stats">
				<div>
					<dt>輸入</dt>
					<dd>{formatTokens(usage.input)}</dd>
				</div>
				<div>
					<dt>快取讀取</dt>
					<dd>{formatTokens(usage.cacheRead)}</dd>
				</div>
				<div>
					<dt>快取寫入</dt>
					<dd>{formatTokens(usage.cacheWrite)}</dd>
				</div>
				<div>
					<dt>輸出</dt>
					<dd>{formatTokens(usage.output)}</dd>
				</div>
			</dl>
		</Sheet>
	);
}
