import { useCallback, useEffect, useState } from "react";
import type { Change, FileEntry, RepoStatus, Workspace } from "../agent/sandbox/workspace.ts";
import { type DiffTarget, DiffView } from "./DiffView.tsx";
import { FileViewer } from "./FileViewer.tsx";
import { BackIcon, ChevronIcon, FileIcon, RefreshIcon } from "./icons.tsx";
import { useBack } from "./layers.ts";
import { resolvePath } from "./openFile.ts";
import { Layer } from "./Sheet.tsx";

export type WorkspaceTab = "files" | "git";

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

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

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** One Android back step per directory level below the root. */
function BackStep({ onBack }: { onBack: () => void }) {
	useBack(true, onBack);
	return null;
}

/** Directory levels from the workspace root down to the folder holding `file`. */
function levelsTo(root: string, file: string | undefined): string[] {
	const levels = [root];
	if (!file?.startsWith(`${root}/`)) return levels;
	const parts = file.slice(root.length + 1).split("/").slice(0, -1);
	for (const part of parts) levels.push(`${levels.at(-1)}/${part}`);
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
	const [entries, setEntries] = useState<FileEntry[]>();
	const [error, setError] = useState("");
	const path = stack.at(-1) ?? workspace.root;

	useEffect(() => {
		let live = true;
		setEntries(undefined);
		setError("");
		workspace.list(path).then(
			(items) => live && setEntries(items),
			(failure: unknown) => live && setError(errorText(failure)),
		);
		return () => {
			live = false;
		};
	}, [workspace, path, reloadKey]);

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
							onClick={() => (entry.kind === "directory" ? setStack([...stack, `${path}/${entry.name}`]) : onOpen(`${path}/${entry.name}`))}
						>
							<span className={`file-kind ${entry.kind}`}>{entry.kind === "directory" ? "▸" : <FileIcon size={14} />}</span>
							<span className="file-name">
								{entry.name}
								{entry.kind === "directory" ? "/" : ""}
							</span>
							<span className="file-meta">{entry.kind === "directory" ? "" : formatSize(entry.size)}</span>
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}

const STATUS_LABEL: Record<string, string> = { "??": "U", A: "A", M: "M", D: "D", R: "R", C: "C", T: "T", U: "!" };

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
	const [repos, setRepos] = useState<RepoStatus[]>();
	const [error, setError] = useState("");

	useEffect(() => {
		let live = true;
		setError("");
		workspace
			.repos()
			.then((paths) => Promise.all(paths.map((path) => workspace.status(path))))
			.then(
				(items) => live && setRepos(items),
				(failure: unknown) => live && setError(errorText(failure)),
			);
		return () => {
			live = false;
		};
	}, [workspace, reloadKey]);

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
									onClick={() => onDiff({ repo: repo.path, title: change.path, load: () => workspace.diff(repo.path, change) })}
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
									onClick={() => onDiff({ repo: repo.path, title: `${commit.hash} ${commit.subject}`, load: () => workspace.show(repo.path, commit.hash) })}
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

/** Full-screen view of the conversation's sandbox: files and git changes, with file and diff viewers on top. */
export function WorkspaceView({
	open,
	load,
	initial,
	onClose,
}: {
	open: boolean;
	/** Resolves the workspace, or undefined when the conversation has no sandbox yet. */
	load: () => Promise<Workspace | undefined>;
	initial: { tab: WorkspaceTab; file?: string };
	onClose: () => void;
}) {
	const [workspace, setWorkspace] = useState<Workspace | null>();
	const [error, setError] = useState("");
	const [tab, setTab] = useState<WorkspaceTab>(initial.tab);
	const [file, setFile] = useState<string>();
	const [diff, setDiff] = useState<DiffTarget>();
	const [reloadKey, setReloadKey] = useState(0);

	useEffect(() => {
		if (!open) return;
		let current = true;
		setTab(initial.tab);
		setFile(undefined);
		setDiff(undefined);
		setError("");
		setWorkspace(undefined);
		load().then(
			(value) => {
				if (!current) return;
				setWorkspace(value ?? null);
				// Tool paths are relative to the workspace root unless absolute.
				if (value && initial.file) setFile(resolvePath(value.root, initial.file));
			},
			(failure: unknown) => {
				if (current) setError(errorText(failure));
			},
		);
		return () => {
			current = false;
		};
	}, [open, initial, load]);

	const refresh = useCallback(() => setReloadKey((key) => key + 1), []);

	return (
		<Layer open={open} kind="page" onClose={onClose} label="工作區">
			<div className="screen">
				<header className="bar">
					<button type="button" className="icon-button" onClick={onClose} aria-label="返回">
						<BackIcon />
					</button>
					<h1 className="bar-heading">工作區</h1>
					<button type="button" className="icon-button" onClick={refresh} aria-label="重新整理" disabled={!workspace}>
						<RefreshIcon />
					</button>
				</header>
				<div className="tabs" role="tablist">
					{(
						[
							["files", "檔案"],
							["git", "變更"],
						] as const
					).map(([value, label]) => (
						<button type="button" role="tab" key={value} aria-selected={tab === value} className={tab === value ? "selected" : ""} onClick={() => setTab(value)}>
							{label}
						</button>
					))}
				</div>
				{error ? <div className="ws-pane"><div className="banner error">{error}</div></div> : null}
				{workspace === undefined && !error ? <div className="ws-pane"><div className="ws-loading">連接 sandbox</div></div> : null}
				{workspace === null ? (
					<div className="ws-pane">
						<div className="ws-empty">這個 Bot 還沒用過 sandbox。請它在 sandbox 裡做點事，檔案就會出現在這裡。</div>
					</div>
				) : null}
				{workspace && tab === "files" ? (
					<FileBrowser workspace={workspace} start={initial.file && resolvePath(workspace.root, initial.file)} onOpen={setFile} reloadKey={reloadKey} />
				) : null}
				{workspace && tab === "git" ? <GitPanel workspace={workspace} onDiff={setDiff} reloadKey={reloadKey} /> : null}
			</div>
			{workspace ? <FileViewer workspace={workspace} path={file} onClose={() => setFile(undefined)} /> : null}
			<DiffView target={diff} onClose={() => setDiff(undefined)} />
		</Layer>
	);
}
