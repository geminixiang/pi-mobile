import type { ConversationView } from "@earendil-works/pi-durable";
import type { ReactNode } from "react";
import { BoxIcon, CopyIcon, FileIcon, LayersIcon, PencilIcon, RefreshIcon } from "./icons.tsx";
import { entryText } from "./Message.tsx";
import type { Prefs } from "./prefs.ts";
import { Sheet } from "./Sheet.tsx";
import { formatTokens, type Usage } from "./usage.ts";

export interface MenuActions {
	rename: () => void;
	compact: () => void;
	reset: () => void;
	resetSandbox?: () => void;
	workspace?: () => void;
	copy: (text: string) => void;
}

function Item({ icon, label, hint, danger, disabled, onClick }: { icon: ReactNode; label: string; hint?: string; danger?: boolean; disabled?: boolean; onClick: () => void }) {
	return (
		<button type="button" className={danger ? "danger" : ""} disabled={disabled} onClick={onClick}>
			{icon}
			<span className="menu-text">
				{label}
				{hint ? <span className="menu-hint">{hint}</span> : null}
			</span>
		</button>
	);
}

export function ConversationMenu({
	open,
	view,
	title,
	usage,
	context,
	prefs,
	onPrefs,
	actions,
	onClose,
}: {
	open: boolean;
	view: ConversationView | undefined;
	title: string;
	usage: Usage;
	context: { used: number; window: number };
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
	const percent = context.window ? Math.min(100, (context.used / context.window) * 100) : 0;

	return (
		<Sheet open={open} onClose={onClose} title={title || "對話"}>
			<div className="context-card">
				<div className="context-top">
					<span className="strip-label">上下文</span>
					<span className="context-numbers">
						{formatTokens(context.used)} / {formatTokens(context.window)}
						<b>{percent.toFixed(0)}%</b>
					</span>
				</div>
				<div className="context-bar">
					<i style={{ width: `${Math.max(percent, 1.5)}%` }} />
				</div>
				<dl className="stats">
					<div>
						<dt>輸入</dt>
						<dd>{formatTokens(usage.input)}</dd>
					</div>
					<div>
						<dt>輸出</dt>
						<dd>{formatTokens(usage.output)}</dd>
					</div>
					<div>
						<dt>快取讀</dt>
						<dd>{formatTokens(usage.cacheRead)}</dd>
					</div>
					<div>
						<dt>快取寫</dt>
						<dd>{formatTokens(usage.cacheWrite)}</dd>
					</div>
				</dl>
			</div>
			{actions.workspace ? (
				<div className="menu">
					<Item icon={<FileIcon size={18} />} label="檔案與變更" hint="瀏覽 sandbox 裡的檔案，查看 git diff 和 commit" onClick={run(actions.workspace)} />
				</div>
			) : null}
			<div className="menu">
				<Item icon={<PencilIcon size={18} />} label="重新命名" onClick={run(actions.rename)} />
				<Item
					icon={<CopyIcon size={18} />}
					label="複製最後的回答"
					disabled={!lastAnswer}
					onClick={run(() => lastAnswer && actions.copy(entryText(lastAnswer)))}
				/>
				<Item icon={<LayersIcon />} label="壓縮對話" hint="把較早的內容摘要起來，騰出上下文" onClick={run(actions.compact)} />
				<Item icon={<RefreshIcon />} label="新的上下文" hint="模型看不到之前的訊息，紀錄保留" onClick={run(actions.reset)} />
				{actions.resetSandbox ? (
					<Item icon={<BoxIcon size={18} />} label="重置 sandbox" hint="刪除這個對話的容器和檔案" danger onClick={run(actions.resetSandbox)} />
				) : null}
			</div>
			<div className="menu toggles">
				<label>
					<span className="menu-text">顯示思考過程</span>
					<input type="checkbox" checked={prefs.showThinking} onChange={(event) => onPrefs({ showThinking: event.target.checked })} />
				</label>
				<label>
					<span className="menu-text">預設展開工具輸出</span>
					<input type="checkbox" checked={prefs.expandTools} onChange={(event) => onPrefs({ expandTools: event.target.checked })} />
				</label>
			</div>
		</Sheet>
	);
}
