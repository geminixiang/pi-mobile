// Settings › MCP: the user's MCP servers (agent/mcp.ts). Adding one takes a name and a URL; after saving, the app
// connects, and a server that needs it gets a 登入 button that signs in in the browser. Each server's tools become a
// toolset bots can be given or denied in their panels.
import { useEffect, useState } from "react";
import type { Bot } from "../agent/bots.ts";
import { extensionName, type McpServer, type McpStatus, parseMcpServers, serverId } from "../agent/mcp.ts";
import type { AgentRuntime } from "../agent/runtime.ts";

function statusText(status: McpStatus | undefined): string {
	switch (status?.state) {
		case undefined:
			return "儲存後連線";
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

function useStatuses(runtime: AgentRuntime | undefined): (id: string) => McpStatus | undefined {
	const [, setVersion] = useState(0);
	useEffect(() => runtime?.mcp.subscribe(() => setVersion((version) => version + 1)), [runtime]);
	return (id) => (runtime?.mcp.servers.some((server) => server.id === id) ? runtime.mcp.status(id) : undefined);
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

export function McpGroup({
	value,
	runtime,
	onChange,
	onError,
}: {
	/** settings.mcpServers */
	value: string;
	/** The running agent, whose connections are those of the saved settings. */
	runtime: AgentRuntime | undefined;
	onChange: (value: string) => void;
	onError: (message: string) => void;
}) {
	const servers = parseMcpServers(value);
	const status = useStatuses(runtime);
	const [draft, setDraft] = useState({ name: "", url: "" });
	const validUrl = /^https:\/\/[^\s/]+/.test(draft.url.trim());

	const add = () => {
		const url = draft.url.trim();
		let host = url;
		try {
			host = new URL(url).hostname;
		} catch {
			// validUrl said it is one.
		}
		const name = draft.name.trim() || host;
		const server: McpServer = { id: serverId(name, url, servers.map((item) => item.id)), name, url };
		onChange(JSON.stringify([...servers, server]));
		setDraft({ name: "", url: "" });
	};
	const remove = (id: string) => {
		void runtime?.mcp.logout(id);
		onChange(JSON.stringify(servers.filter((server) => server.id !== id)));
	};
	const run = (action: () => Promise<void> | void) => () => {
		void Promise.resolve()
			.then(action)
			.catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)));
	};

	return (
		<>
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
			<button type="button" className="btn" disabled={!validUrl} onClick={add}>
				新增
			</button>
		</>
	);
}
