// Settings › MCP: the user's MCP servers (agent/mcp.ts). Adding one by URL connects at once, outside the settings
// form; a server that needs it gets a 登入 button that signs in in the browser. Each server's tools become a toolset
// that bots get when the user picks them, here or in their panels.
import { useEffect, useState } from "react";
import type { Bot } from "../agent/bots.ts";
import { extensionName, type McpServer, type McpStatus } from "../agent/mcp.ts";
import { CATALOG, CATEGORIES, type CatalogCategory, type CatalogEntry } from "../agent/mcp-catalog.ts";
import type { AgentRuntime } from "../agent/runtime.ts";
import { Sheet } from "./Sheet.tsx";

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

/** Re-renders when a server is added, removed, or changes status. */
function useMcp(runtime: AgentRuntime | undefined): void {
	const [, setVersion] = useState(0);
	useEffect(() => runtime?.mcp.subscribe(() => setVersion((version) => version + 1)), [runtime]);
}

/** Which bots may use a server: none until the user picks them, here or in a bot's panel. */
function ServerBots({ runtime, server, onError }: { runtime: AgentRuntime; server: McpServer; onError: (message: string) => void }) {
	const [bots, setBots] = useState<{ bot: Bot; enabled: boolean }[]>([]);
	const toolset = extensionName(server);
	const load = () =>
		void runtime
			.bots()
			.then((list) => Promise.all(list.map(async (bot) => ({ bot, enabled: (await runtime.toolsets(bot.id)).some((item) => item.id === toolset && item.enabled) }))))
			.then(setBots);
	useEffect(load, [runtime, toolset]);
	return (
		<div className="bot-chips" role="group" aria-label={`可以用 ${server.name} 的 Bot`}>
			{bots.map(({ bot, enabled }) => (
				<label key={String(bot.id)} className="chip">
					<input
						type="checkbox"
						checked={enabled}
						onChange={(event) => {
							const next = event.target.checked;
							setBots((current) => current.map((item) => (item.bot.id === bot.id ? { ...item, enabled: next } : item)));
							runtime.setToolset(bot.id, toolset, next).catch((error: unknown) => {
								onError(error instanceof Error ? error.message : String(error));
								load();
							});
						}}
					/>
					{bot.name}
				</label>
			))}
		</div>
	);
}

/** The catalog of services (mcp-catalog.ts) by category; 連接 adds one and, when it needs it, starts its sign-in. */
function Catalog({ open, runtime, onClose, onError }: { open: boolean; runtime: AgentRuntime; onClose: () => void; onError: (message: string) => void }) {
	const connected = new Set(runtime.mcp.servers.map((server) => server.url));
	const connect = (entry: CatalogEntry) => {
		const server = runtime.mcp.add(entry.name, entry.url);
		onClose();
		if (entry.auth === "oauth") runtime.mcp.login(server.id).catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)));
	};
	const categories = Object.keys(CATEGORIES).filter((key): key is CatalogCategory => key in CATEGORIES);
	return (
		<Sheet open={open} title="連接服務" onClose={onClose}>
			<div className="catalog">
				{categories.map((category) => (
					<section key={category}>
						<h3 className="strip-label">{CATEGORIES[category]}</h3>
						<div className="menu">
							{CATALOG.filter((entry) => entry.category === category).map((entry) => (
								<div className="check-row" key={entry.url}>
									<span className="menu-text">
										{entry.name}
										<span className="menu-hint">{entry.description}</span>
										{entry.auth === "oauth" ? <span className="toolset-load">需要登入</span> : null}
									</span>
									{connected.has(entry.url) ? (
										<span className="state on">已連接</span>
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

export function McpGroup({ runtime, onError }: { runtime: AgentRuntime | undefined; onError: (message: string) => void }) {
	useMcp(runtime);
	const servers = runtime?.mcp.servers ?? [];
	const status = (id: string) => runtime?.mcp.status(id);
	const [draft, setDraft] = useState({ name: "", url: "" });
	const [browsing, setBrowsing] = useState(false);
	const validUrl = /^https:\/\/[^\s/]+/.test(draft.url.trim());

	const add = () => {
		const url = draft.url.trim();
		let host = url;
		try {
			host = new URL(url).hostname;
		} catch {
			// validUrl said it is one.
		}
		runtime?.mcp.add(draft.name.trim() || host, url);
		setDraft({ name: "", url: "" });
	};
	const remove = (id: string) => void runtime?.mcp.remove(id).catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)));
	const run = (action: () => Promise<void> | void) => () => {
		void Promise.resolve()
			.then(action)
			.catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)));
	};

	return (
		<>
			{runtime ? (
				<>
					<div className="check-row">
						<span className="menu-text">瀏覽服務</span>
						<button type="button" className="btn" onClick={() => setBrowsing(true)}>
							瀏覽
						</button>
					</div>
					<Catalog open={browsing} runtime={runtime} onClose={() => setBrowsing(false)} onError={onError} />
				</>
			) : null}
			{servers.map((server) => {
				const current = status(server.id);
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
								<button type="button" className="btn" onClick={run(() => (current.state === "login" ? runtime?.mcp.login(server.id) : runtime?.mcp.refresh(server.id)))}>
									{current.state === "login" ? "登入" : "連線"}
								</button>
							) : null}
							<button type="button" className="btn" onClick={() => remove(server.id)}>
								移除
							</button>
						</span>
					</div>
					{current && runtime ? <ServerBots runtime={runtime} server={server} onError={onError} /> : null}
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
			<button type="button" className="btn" disabled={!validUrl || !runtime} onClick={add}>
				新增
			</button>
		</>
	);
}
