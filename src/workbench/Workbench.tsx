import type { ReactNode } from "react";
import type { Bot } from "../agent/bots.ts";
import type { Workspace } from "../agent/sandbox/workspace.ts";
import { BotAvatar } from "../app/BotAvatar.tsx";
import { FileViewer } from "../app/FileViewer.tsx";
import { CloseIcon, FileIcon, FolderIcon } from "../app/icons.tsx";
import { useReach } from "../app/Links.tsx";
import { useLoaded } from "../app/loaded.ts";
import { resolvePath } from "../app/openFile.ts";
import { WorkspaceView } from "../app/WorkspaceView.tsx";
import { type Bench, BOT_TAB, keyOf, type Tab } from "./bench.ts";

const nameOf = (path: string) => path.split("/").at(-1) ?? path;

function TabLabel({ tab, bot }: { tab: Tab; bot: Bot | undefined }) {
	if (tab.kind === "bot") {
		return (
			<>
				{bot ? <BotAvatar bot={bot} size={20} /> : null}
				<span className="bench-tab-name">{bot?.name ?? "Bot"}</span>
			</>
		);
	}
	if (tab.kind === "folder") {
		return (
			<>
				<FolderIcon size={14} />
				<span className="bench-tab-name">工作區</span>
			</>
		);
	}
	return (
		<>
			<FileIcon size={14} />
			<span className="bench-tab-name">{nameOf(tab.path)}</span>
		</>
	);
}

function LinkMark({ provider, onClick }: { provider: string; onClick: () => void }) {
	const reach = useReach(provider);
	return (
		<button type="button" className="bench-link" aria-label="連線" onClick={onClick}>
			<svg width="64" height="14" viewBox="0 0 64 14" aria-hidden="true">
				<circle cx="6" cy="7" r="5" />
				<line x1="11" y1="7" x2="25" y2="7" />
				<circle className="bench-link-pi" cx="32" cy="7" r="6" />
				<line x1="39" y1="7" x2="53" y2="7" />
				<circle cx="58" cy="7" r="5" />
			</svg>
			<i className={`link-mark ${reach.kind}`} />
		</button>
	);
}

function FilePane({ workspace, path }: { workspace: Workspace | null | undefined; path: string }) {
	if (workspace === undefined) return <div className="ws-loading">讀取中</div>;
	if (workspace === null) return <div className="ws-empty">還沒有資料夾</div>;
	return <FileViewer workspace={workspace} path={resolvePath(workspace.root, path)} frame={{ kind: "tab" }} />;
}

export function Workbench({
	bot,
	bench,
	provider,
	load,
	botPane,
	onShow,
	onClose,
}: {
	bot: Bot | undefined;
	bench: Bench;
	provider: string;
	load: () => Promise<Workspace | undefined>;
	botPane: (shown: boolean) => ReactNode;
	onShow: (tab: Tab) => void;
	onClose: (key: string) => void;
}) {
	const { value: workspace, error } = useLoaded(async () => (await load()) ?? null, [load]);
	const pane = (tab: Tab, shown: boolean) => {
		if (tab.kind === "bot") return botPane(shown);
		if (tab.kind === "folder") return <WorkspaceView load={load} initial={{ tab: "files" }} onClose={() => onClose(keyOf(tab))} onOpenFile={(path) => onShow({ kind: "file", path })} />;
		return error ? <div className="banner error">{error}</div> : <FilePane workspace={workspace} path={tab.path} />;
	};
	return (
		<section className="bench" aria-label="工作台">
			<div className="bench-head">
				<div className="bench-tabs" role="tablist">
					{bench.tabs.map((tab) => {
						const key = keyOf(tab);
						const on = key === bench.active;
						return (
							<div key={key} className={`bench-tab${on ? " on" : ""}`}>
								<button type="button" role="tab" aria-selected={on} className="bench-tab-open" onClick={() => onShow(tab)}>
									<TabLabel tab={tab} bot={bot} />
								</button>
								{tab.kind === "bot" ? null : (
									<button type="button" className="bench-tab-close" aria-label="關閉分頁" onClick={() => onClose(key)}>
										<CloseIcon size={12} />
									</button>
								)}
							</div>
						);
					})}
				</div>
				<LinkMark provider={provider} onClick={() => onShow(BOT_TAB)} />
			</div>
			<div className="bench-body">
				{bench.tabs.map((tab) => {
					const key = keyOf(tab);
					const shown = key === bench.active;
					return (
						<div key={key} className="bench-pane" role="tabpanel" hidden={!shown}>
							{pane(tab, shown)}
						</div>
					);
				})}
			</div>
		</section>
	);
}
