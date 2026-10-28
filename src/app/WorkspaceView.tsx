import { memo, useEffect, useState } from "react";
import type { Change, Workspace } from "../agent/sandbox/workspace.ts";
import { type DiffTarget, DiffView } from "./DiffView.tsx";
import { FileViewer } from "./FileViewer.tsx";
import { ChevronIcon, FileIcon, RefreshIcon } from "./icons.tsx";
import { useBack } from "./layers.ts";
import { joinPath, resolvePath } from "./openFile.ts";
import { Layer } from "./Sheet.tsx";
import { BackButton } from "./BackButton.tsx";
import { Tabs } from "./Segmented.tsx";
import { useLoaded } from "./loaded.ts";
import { formatBytes } from "../agent/tools/common.ts";

export type WorkspaceTab = "files" | "git";

const relative = new Intl.RelativeTimeFormat("zh-TW", { numeric: "auto" });
function ago(time: number): string {
	const seconds = (time - Date.now()) / 1000;
	const steps: [Intl.RelativeTimeFormatUnit, number][] = [
		["second", 60],
		["minute", 60],
		["hour", 24],
		["day", 30],
		["month", 12],
	];
	let value = seconds;
	for (const [unit, size] of steps) {
		if (Math.abs(value) < size) return relative.format(Math.round(value), unit);
		value /= size;
	}
	return relative.format(Math.round(value), "year");
}

function BackStep({ onBack }: { onBack: () => void }) {
	useBack(true, onBack);
	return null;
}

function levelsTo(root: string, file: string | undefined): string[] {
	const levels = [root];
	const prefix = joinPath(root, "");
	if (!file?.startsWith(prefix)) return levels;
	const parts = file.slice(prefix.length).split("/").slice(0, -1);
	for (const part of parts) levels.push(joinPath(levels.at(-1) ?? root, part));
	return levels;
}

function FileBrowser({
	workspace,
	start,
	onOpen,
	reloadKey,
}: {
	workspace: Workspace;
	start: string | undefined;
	onOpen: (path: string) => void;
	reloadKey: number;
}) {
	const [stack, setStack] = useState<string[]>(() => levelsTo(workspace.root, start));
	const path = stack.at(-1) ?? workspace.root;
	const { value: entries, error } = useLoaded(() => workspace.list(path), [workspace, path, reloadKey]);

	const crumbs = path.split("/").filter(Boolean);
	return (
		<div className="ws-pane">
			{stack.slice(1).map((level) => (
				<BackStep key={level} onBack={() => setStack((current) => current.slice(0, -1))} />
			))}
			<nav className="crumbs" aria-label="路徑">
				{crumbs.map((name, index) => {
					const target = `/${crumbs.slice(0, index + 1).join("/")}`;
					const reachable = target.length >= workspace.root.length;
					return (
						<span key={target}>
							<span className="crumb-sep">/</span>
							<button
								type="button"
								disabled={!reachable || target === path}
								onClick={() => setStack((current) => current.slice(0, current.indexOf(target) + 1))}
							>
								{name}
							</button>
						</span>
					);
				})}
			</nav>
			{error ? <div className="banner error">{error}</div> : null}
			{!entries && !error ? <div className="ws-loading">讀取中</div> : null}
			{entries?.length === 0 ? <div className="ws-empty">這個資料夾是空的</div> : null}
			<ul className="file-list">
				{entries?.map((entry) => (
					<li key={entry.name}>
						<button
							type="button"
							onClick={() => (entry.kind === "directory" ? setStack([...stack, joinPath(path, entry.name)]) : onOpen(joinPath(path, entry.name)))}
						>
							<span className={`file-kind ${entry.kind}`}>{entry.kind === "directory" ? "▸" : <FileIcon size={14} />}</span>
							<span className="file-name">
								{entry.name}
								{entry.kind === "directory" ? "/" : ""}
							</span>
							<span className="file-meta">{entry.kind === "directory" ? "" : formatBytes(entry.size)}</span>
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}

const STATUS_LABEL: Record<string, string> = { "??": "U", U: "!" };

function statusLetter(change: Change): string {
	const code = change.status === "??" ? "??" : (change.status.trim()[0] ?? "M");
	return STATUS_LABEL[code] ?? code;
}

function statusTone(change: Change): string {
	if (change.status === "??" || change.status.includes("A")) return "added";
	if (change.status.includes("D")) return "deleted";
	return "modified";
}

function repoName(root: string, path: string): string {
	return path === root ? (root.split("/").at(-1) ?? root) : path.slice(root.length + 1);
}

function GitPanel({ workspace, onDiff, reloadKey }: { workspace: Workspace; onDiff: (target: DiffTarget) => void; reloadKey: number }) {
	const { value: repos, error } = useLoaded(
		() => workspace.repos().then((paths) => Promise.all(paths.map((path) => workspace.status(path)))),
		[workspace, reloadKey],
	);

	if (error) return <div className="ws-pane"><div className="banner error">{error}</div></div>;
	if (!repos) return <div className="ws-pane"><div className="ws-loading">讀取中</div></div>;
	if (repos.length === 0) return <div className="ws-pane"><div className="ws-empty">{workspace.root} 裡沒有 git repo</div></div>;
	return (
		<div className="ws-pane">
			{repos.map((repo) => (
				<section className="repo" key={repo.path}>
					<header className="strip">
						<span className="strip-title">{repoName(workspace.root, repo.path)}</span>
						<span className="repo-branch">
							{repo.branch}
							{repo.ahead ? ` ↑${repo.ahead}` : ""}
							{repo.behind ? ` ↓${repo.behind}` : ""}
						</span>
					</header>
					<div className="strip-label repo-section">變更 · {repo.changes.length}</div>
					{repo.changes.length === 0 ? <div className="ws-empty small">沒有未提交的變更</div> : null}
					<ul className="change-list">
						{repo.changes.map((change) => (
							<li key={change.path}>
								<button
									type="button"
									onClick={() => onDiff({ title: change.path, load: () => workspace.diff(repo.path, change) })}
								>
									<span className={`change-status ${statusTone(change)}`}>{statusLetter(change)}</span>
									<span className="file-name">{change.path}</span>
									{change.added !== undefined ? (
										<span className="change-counts">
											<b className="plus">+{change.added}</b> <b className="minus">−{change.removed}</b>
										</span>
									) : null}
									<ChevronIcon size={12} />
								</button>
							</li>
						))}
					</ul>
					{repo.commits.length > 0 ? <div className="strip-label repo-section">最近的 commit</div> : null}
					<ul className="change-list">
						{repo.commits.map((commit) => (
							<li key={commit.hash}>
								<button
									type="button"
									onClick={() => onDiff({ title: `${commit.hash} ${commit.subject}`, load: () => workspace.show(repo.path, commit.hash) })}
								>
									<span className="commit-hash">{commit.hash}</span>
									<span className="commit-text">
										<span className="file-name">{commit.subject}</span>
										<span className="commit-meta">
											{commit.author} · {ago(commit.time)}
										</span>
									</span>
									<ChevronIcon size={12} />
								</button>
							</li>
						))}
					</ul>
				</section>
			))}
		</div>
	);
}

export const WorkspaceView = memo(function WorkspaceView({
	open,
	load,
	initial,
	onClose,
}: {
	open: boolean;
	load: () => Promise<Workspace | undefined>;
	initial: { tab: WorkspaceTab; file?: string };
	onClose: () => void;
}) {
	const { value: workspace, error } = useLoaded(open ? async () => (await load()) ?? null : undefined, [open, initial, load]);
	const [tab, setTab] = useState<WorkspaceTab>(initial.tab);
	const [file, setFile] = useState<string>();
	const [diff, setDiff] = useState<DiffTarget>();
	const [reloadKey, setReloadKey] = useState(0);

	useEffect(() => {
		if (!open) return;
		setTab(initial.tab);
		setFile(initial.file);
		setDiff(undefined);
	}, [open, initial]);

	return (
		<Layer open={open} kind="page" onClose={onClose} label="工作區">
			<div className="screen">
				<header className="bar">
					<BackButton onClick={onClose} />
					<h1 className="bar-heading">工作區</h1>
					<button type="button" className="icon-button" onClick={() => setReloadKey((key) => key + 1)} aria-label="重新整理" disabled={!workspace}>
						<RefreshIcon />
					</button>
				</header>
				<Tabs options={workspace?.git === false ? [["files", "檔案"]] : [["files", "檔案"], ["git", "變更"]]} value={tab} onChange={setTab} />
				{error ? <div className="ws-pane"><div className="banner error">{error}</div></div> : null}
				{workspace === undefined && !error ? <div className="ws-pane"><div className="ws-loading">連接電腦</div></div> : null}
				{workspace === null ? (
					<div className="ws-pane">
						<div className="ws-empty">還沒有資料夾</div>
					</div>
				) : null}
				{workspace && tab === "files" ? (
					<FileBrowser workspace={workspace} start={initial.file && resolvePath(workspace.root, initial.file)} onOpen={setFile} reloadKey={reloadKey} />
				) : null}
				{workspace && tab === "git" ? <GitPanel workspace={workspace} onDiff={setDiff} reloadKey={reloadKey} /> : null}
			</div>
			{workspace ? <FileViewer workspace={workspace} path={file && resolvePath(workspace.root, file)} onClose={() => setFile(undefined)} /> : null}
			<DiffView target={diff} onClose={() => setDiff(undefined)} />
		</Layer>
	);
});
