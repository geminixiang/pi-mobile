import { useEffect, useState } from "react";
import type { Bot } from "../agent/bots.ts";
import { extensionName, type McpStatus } from "../agent/mcp.ts";
import { CATALOG, CATEGORIES, type CatalogEntry } from "../agent/mcp-catalog.ts";
import type { AgentRuntime } from "../agent/runtime.ts";
import { Sheet } from "./Sheet.tsx";
import { messageOf } from "../promise.ts";

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

type Grants = { bot: Bot; enabled: ReadonlySet<string> }[];

function Catalog({ open, runtime, onClose, onError }: { open: boolean; runtime: AgentRuntime; onClose: () => void; onError: (message: string) => void }) {
	const connected = new Set(runtime.mcp.servers.map((server) => server.url));
	const connect = (entry: CatalogEntry) => {
		onClose();
		runtime.mcp
			.add(entry.name, entry.url)
			.then((server) => (entry.auth === "oauth" ? runtime.mcp.login(server.id) : undefined))
			.catch((error: unknown) => onError(messageOf(error)));
	};
	return (
		<Sheet open={open} title="連接服務" onClose={onClose}>
			<div className="catalog">
				{Object.entries(CATEGORIES).map(([category, title]) => (
					<section key={category}>
						<h3 className="strip-label">{title}</h3>
						<div className="menu">
							{CATALOG.filter((entry) => entry.category === category).map((entry) => (
								<div className="check-row" key={entry.url}>
									<span className="menu-text">
										{entry.name}
										<span className="menu-hint">{entry.description}</span>
										{entry.auth === "oauth" ? <span className="toolset-load">需要登入</span> : null}
									</span>
									{connected.has(entry.url) ? (
										<span className="state">已連接</span>
									) : (
										<button type="button" className="btn" onClick={() => connect(entry)}>
											連接
										</button>
									)}
								</div>
							))}
						</div>
					</section>
				))}
			</div>
		</Sheet>
	);
}

export function McpGroup({ runtime, onError }: { runtime: AgentRuntime; onError: (message: string) => void }) {
	useMcp(runtime);
	const servers = runtime.mcp.servers;
	const [draft, setDraft] = useState({ name: "", url: "" });
	const [browsing, setBrowsing] = useState(false);
	const [grants, setGrants] = useState<Grants>([]);
	const fail = (error: unknown) => onError(messageOf(error));
	const loadGrants = () => {
		void runtime
			.bots()
			.then((list) => Promise.all(list.map(async (bot) => ({ bot, enabled: new Set((await runtime.toolsets(bot.id)).filter((item) => item.enabled).map((item) => item.id)) }))))
			.then(setGrants);
	};
	useEffect(loadGrants, [runtime]);
	const grant = (bot: Bot, toolset: string, enabled: boolean) => {
		setGrants((current) =>
			current.map((item) => (item.bot.id === bot.id ? { bot, enabled: enabled ? new Set([...item.enabled, toolset]) : new Set([...item.enabled].filter((id) => id !== toolset)) } : item)),
		);
		runtime.setToolset(bot.id, toolset, enabled).catch((error: unknown) => {
			fail(error);
			loadGrants();
		});
	};
	const add = () => {
		const url = draft.url.trim();
		const host = URL.canParse(url) ? new URL(url).hostname : url;
		runtime.mcp.add(draft.name.trim() || host, url).catch(fail);
		setDraft({ name: "", url: "" });
	};

	return (
		<>
			<button type="button" className="btn" onClick={() => setBrowsing(true)}>
				瀏覽服務
			</button>
			<Catalog open={browsing} runtime={runtime} onClose={() => setBrowsing(false)} onError={onError} />
			{servers.map((server) => {
				const current = runtime.mcp.status(server.id);
				return (
					<div className="mcp-server" key={server.id}>
						<div className="check-row">
							<span className="menu-text">
								{server.name}
								<span className="menu-hint mcp-url">
									{server.url}
									<br />
									{statusText(current)}
								</span>
							</span>
							<span className="row-actions">
								{current && current.state !== "ready" && current.state !== "connecting" ? (
									<button type="button" className="btn" onClick={() => (current.state === "login" ? void runtime.mcp.login(server.id).catch(fail) : runtime.mcp.refresh(server.id))}>
										{current.state === "login" ? "登入" : "連線"}
									</button>
								) : null}
								<button type="button" className="btn" onClick={() => void runtime.mcp.remove(server.id).catch(fail)}>
									移除
								</button>
							</span>
						</div>
						{current ? (
							<div className="bot-chips" role="group" aria-label={`可以用 ${server.name} 的 Bot`}>
								{grants.map(({ bot, enabled }) => (
									<label key={String(bot.id)} className="chip">
										<input type="checkbox" checked={enabled.has(extensionName(server))} onChange={(event) => grant(bot, extensionName(server), event.target.checked)} />
										{bot.name}
									</label>
								))}
							</div>
						) : null}
					</div>
				);
			})}
			<label>
				<span>或輸入網址</span>
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
		</>
	);
}
