import { Logo } from "./Logo.tsx";
import { useEffect, useState } from "react";
import type { Bot } from "../agent/bots.ts";
import { extensionName, type McpServer, type McpStatus } from "../agent/mcp.ts";
import { CATALOG, CATEGORIES, type CatalogEntry } from "../agent/mcp-catalog.ts";
import type { AgentRuntime } from "../agent/runtime.ts";
import { BotAvatar } from "./BotAvatar.tsx";
import { PlusIcon } from "./icons.tsx";
import { Sheet } from "./Sheet.tsx";
import { messageOf } from "../promise.ts";
import { haptic } from "./haptics.ts";

function statusText(status: McpStatus | undefined): string {
	switch (status?.state) {
		case undefined:
			return "";
		case "idle":
			return status.tools > 0 ? `${status.tools} 個工具（上次連線）` : "還沒連線";
		case "connecting":
			return "連線中…";
		case "ready":
			return `已連線 · ${status.tools} 個工具`;
		case "login":
			return "需要登入";
		case "error":
			return `連不上：${status.message}`;
	}
}

export function useMcp(runtime: AgentRuntime | undefined): void {
	const [, setVersion] = useState(0);
	useEffect(() => runtime?.mcp.subscribe(() => setVersion((version) => version + 1)), [runtime]);
}

const host = (url: string) => (URL.canParse(url) ? new URL(url).hostname : url);

type Grants = { bot: Bot; enabled: ReadonlySet<string> }[];

const SHOWN_FACES = 3;
function Catalog({ open, runtime, onClose, onError }: { open: boolean; runtime: AgentRuntime; onClose: () => void; onError: (message: string) => void }) {
	const [draft, setDraft] = useState({ name: "", url: "" });
	const connected = new Set(runtime.mcp.servers.map((server) => server.url));
	const connect = (entry: CatalogEntry) => {
		onClose();
		runtime.mcp
			.add(entry.name, entry.url)
			.then((server) => (entry.auth === "oauth" ? runtime.mcp.login(server.id) : undefined))
			.catch((error: unknown) => onError(messageOf(error)));
	};
	const add = () => {
		const url = draft.url.trim();
		onClose();
		setDraft({ name: "", url: "" });
		runtime.mcp.add(draft.name.trim() || host(url), url).catch((error: unknown) => onError(messageOf(error)));
	};
	return (
		<Sheet open={open} title="加入服務" onClose={onClose}>
			<div className="catalog">
				{Object.entries(CATEGORIES).map(([category, title]) => (
					<section key={category}>
						<h3 className="list-label">{title}</h3>
						{CATALOG.filter((entry) => entry.category === category).map((entry) => (
							<div className="list-row" key={entry.url}>
								<button type="button" className="list-open" disabled={connected.has(entry.url)} onClick={() => connect(entry)}>
									<Logo name={entry.name} icon={entry.icon} />
									<span className="list-text">
										<span className="list-name">{entry.name}</span>
										<span className="list-sub">{entry.description}</span>
									</span>
								</button>
								{connected.has(entry.url) ? <span className="list-meta">已連接</span> : null}
							</div>
						))}
					</section>
				))}
				<details className="manual">
					<summary>自己輸入網址</summary>
					<label>
						<span>網址</span>
						<input
							value={draft.url}
							onChange={(event) => setDraft({ ...draft, url: event.target.value })}
							placeholder="https://example.com/mcp"
							autoCapitalize="off"
							autoComplete="off"
							inputMode="url"
						/>
					</label>
					<label>
						<span>名稱</span>
						<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="選填" autoComplete="off" />
					</label>
					<button type="button" className="btn" disabled={!/^https:\/\/[^\s/]+/.test(draft.url.trim())} onClick={add}>
						新增
					</button>
				</details>
			</div>
		</Sheet>
	);
}

function needsYou(status: McpStatus | undefined): boolean {
	return status?.state === "login" || status?.state === "error";
}

export function McpGroup({ runtime, onError }: { runtime: AgentRuntime; onError: (message: string) => void }) {
	useMcp(runtime);
	const servers = runtime.mcp.servers;
	const [browsing, setBrowsing] = useState(false);
	const [selectedId, setSelectedId] = useState<string>();
	const [grants, setGrants] = useState<Grants>([]);
	const fail = (error: unknown) => onError(messageOf(error));
	useEffect(() => {
		void runtime
			.bots()
			.then((list) => Promise.all(list.map(async (bot) => ({ bot, enabled: new Set((await runtime.toolsets(bot.id)).filter((item) => item.enabled).map((item) => item.id)) }))))
			.then(setGrants);
	}, [runtime]);
	const usersOf = (server: McpServer) => grants.filter(({ enabled }) => enabled.has(extensionName(server))).map(({ bot }) => bot);
	const entryOf = (server: McpServer) => CATALOG.find((entry) => entry.url === server.url);
	const resolve = (server: McpServer, status: McpStatus) => (status.state === "login" ? void runtime.mcp.login(server.id).catch(fail) : runtime.mcp.refresh(server.id));
	const selected = servers.find((server) => server.id === selectedId);
	const selectedStatus = selected && runtime.mcp.status(selected.id);
	const selectedUsers = selected ? usersOf(selected) : [];
	const waiting = servers.filter((server) => needsYou(runtime.mcp.status(server.id)));
	const working = servers.filter((server) => !needsYou(runtime.mcp.status(server.id)));

	return (
		<div className="list">
			{working.length > 0 ? <h3 className="list-label">使用中</h3> : null}
			{working.map((server) => {
				const users = usersOf(server);
				const status = runtime.mcp.status(server.id);
				return (
					<button type="button" className={`list-row list-open${users.length === 0 ? " idle" : ""}`} key={server.id} onClick={() => setSelectedId(server.id)}>
						<Logo name={server.name} icon={entryOf(server)?.icon} />
						<span className="list-text">
							<span className="list-name">{server.name}</span>
							<span className="list-sub">{status?.state === "connecting" ? "連線中…" : (entryOf(server)?.description ?? host(server.url))}</span>
						</span>
						<span className="faces">
							{users.slice(0, SHOWN_FACES).map((bot) => (
								<BotAvatar key={String(bot.id)} bot={bot} size={22} />
							))}
							{users.length > SHOWN_FACES ? <span className="faces-more">+{users.length - SHOWN_FACES}</span> : null}
						</span>
					</button>
				);
			})}
			{waiting.length > 0 ? <h3 className="list-label">點一下登入</h3> : null}
			{waiting.length > 0 ? (
				<div className="service-grid">
					{waiting.map((server) => {
						const status = runtime.mcp.status(server.id);
						return (
							<button
								type="button"
								key={server.id}
								className={`service-cell${status?.state === "error" ? " failed" : ""}`}
								onClick={() => status && resolve(server, status)}
								onContextMenu={(event) => {
									event.preventDefault();
									haptic("press");
									setSelectedId(server.id);
								}}>
								<Logo name={server.name} icon={entryOf(server)?.icon} />
								<span>{server.name}</span>
							</button>
						);
					})}
				</div>
			) : null}
			<button type="button" className="list-add" onClick={() => setBrowsing(true)}>
				<PlusIcon size={16} />
				<span>加入服務</span>
			</button>
			<Catalog open={browsing} runtime={runtime} onClose={() => setBrowsing(false)} onError={onError} />
			<Sheet open={selected !== undefined} title={selected?.name ?? ""} onClose={() => setSelectedId(undefined)}>
				{selected ? (
					<div className="service">
						<p className="service-url">{selected.url}</p>
						<p className="list-sub">{statusText(selectedStatus)}</p>
						{selectedStatus && selectedStatus.shadowed.length > 0 ? <p className="list-sub">{`與內建工具同名，未載入：${selectedStatus.shadowed.join("、")}`}</p> : null}
						<p className="list-sub">{selectedUsers.length > 0 ? `${selectedUsers.map((bot) => bot.name).join("、")} 正在使用` : "還沒有 Bot 使用，到 Bot 面板的工具打開"}</p>
						{selectedStatus && needsYou(selectedStatus) ? (
							<button type="button" className="btn primary" onClick={() => resolve(selected, selectedStatus)}>
								{selectedStatus.state === "login" ? "登入" : "重試"}
							</button>
						) : null}
						<button
							type="button"
							className="service-remove"
							onClick={() => {
								setSelectedId(undefined);
								void runtime.mcp.remove(selected.id).catch(fail);
							}}>
							移除這個服務
						</button>
					</div>
				) : null}
			</Sheet>
		</div>
	);
}
