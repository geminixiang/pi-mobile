import type { ConversationId, ConversationView } from "@earendil-works/pi-durable";
import { useEffect, useState } from "react";
import { type ContextPart, contextParts, type ContextShape, type ToolCost } from "../agent/context-shape.ts";
import { extensionName } from "../agent/mcp.ts";
import type { AgentRuntime } from "../agent/runtime.ts";
import { contextPercent, formatTokens, latestCacheHitRate, totalUsage } from "./usage.ts";

const PART_LABEL: Record<ContextPart["kind"], string> = { messages: "對話", prompt: "系統提示", memory: "記憶", tools: "工具", services: "連接的服務" };

const SECTION_LABEL: Readonly<Record<string, string>> = {
	preamble: "開頭說明",
	bot: "Bot 身分",
	codemode: "程式模式",
	skills: "技能",
	schedules: "排程",
	items: "事項",
	"on-demand": "需要時載入",
	files: "資料夾",
	computer_shell: "電腦",
	computer_agents: "電腦上的 agent",
	notifications: "通知",
	calendar: "行事曆",
	places: "地點",
	apps: "App",
	database: "資料庫",
};

type Measured = { shape: ContextShape; tools: ToolCost };

function Line({ kind, label, tokens, share }: { kind: string; label: string; tokens: number; share: string }) {
	return (
		<>
			<i className={`part-${kind}`} />
			<span className="context-label">{label}</span>
			<span className="context-tokens">{formatTokens(tokens)}</span>
			<span className="context-share">{share}</span>
		</>
	);
}

export function ContextCard({
	runtime,
	botId,
	open,
	view,
	context,
	compactAt,
}: {
	runtime: AgentRuntime;
	botId: ConversationId;
	open: boolean;
	view: ConversationView | undefined;
	context: { used: number; window: number };
	compactAt: number;
}) {
	const [measured, setMeasured] = useState<Measured>();
	const [expanded, setExpanded] = useState(false);
	useEffect(() => {
		if (!open) return;
		const shape = runtime.contextShape(botId);
		if (!shape) {
			setMeasured(undefined);
			return;
		}
		let live = true;
		void runtime.toolCost(botId).then((tools) => {
			if (live) setMeasured({ shape, tools });
		});
		return () => {
			live = false;
		};
	}, [runtime, botId, open, context.used]);
	const percent = contextPercent(context.used, context.window);
	const usage = totalUsage(view);
	const cacheHitRate = latestCacheHitRate(view);
	const share = (tokens: number) => (context.window ? `${((tokens / context.window) * 100).toFixed(1)}%` : "");
	const services = new Map(runtime.mcp.servers.map((server) => [extensionName(server), server.name]));
	const nameOf = (name: string) => SECTION_LABEL[name] ?? services.get(name) ?? name;
	const parts = measured ? contextParts(measured.shape, measured.tools, context.used, context.window, compactAt) : undefined;

	return (
		<div className="context-card">
			<button type="button" className="context-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
				<span className="context-head">
					<span>
						已使用 <b>{percent.toFixed(0)}%</b>
					</span>
					<span className="context-numbers">
						{formatTokens(context.used)} / {formatTokens(context.window)}
					</span>
				</span>
				<span className="context-parts">
					{parts ? (
						<>
							{parts.parts.map((part) => (
								<i key={part.kind} className={`part-${part.kind}`} style={{ "--share": part.tokens / context.window }} />
							))}
							{parts.reserve > 0 ? <i className="part-reserve" style={{ "--share": parts.reserve / context.window }} /> : null}
						</>
					) : (
						<i className="part-messages" style={{ "--share": context.window ? context.used / context.window : 0 }} />
					)}
				</span>
			</button>
			{expanded ? (
				<>
			{parts ? (
				<div className="context-rows">
					{parts.parts.map((part) =>
						part.items.length > 0 ? (
							<details key={part.kind} className="context-row">
								<summary>
									<Line kind={part.kind} label={PART_LABEL[part.kind]} tokens={part.tokens} share={share(part.tokens)} />
								</summary>
								{part.items.map((item) => (
									<div key={item.name} className="context-item">
										<span>{nameOf(item.name)}</span>
										<span className="context-tokens">{formatTokens(item.tokens)}</span>
									</div>
								))}
							</details>
						) : (
							<div key={part.kind} className="context-line">
								<Line kind={part.kind} label={PART_LABEL[part.kind]} tokens={part.tokens} share={share(part.tokens)} />
							</div>
						),
					)}
					{parts.reserve > 0 ? (
						<div className="context-line">
							<Line kind="reserve" label="壓縮保留" tokens={parts.reserve} share={share(parts.reserve)} />
						</div>
					) : null}
					<div className="context-line">
						<Line kind="free" label="剩餘" tokens={parts.free} share={share(parts.free)} />
					</div>
					{parts.deferred > 0 ? (
						<div className="context-line deferred">
							<Line kind="deferred" label="需要時載入" tokens={parts.deferred} share="—" />
						</div>
					) : null}
				</div>
			) : (
				<p className="context-note">下一次對話後列出細目</p>
			)}
			<dl className="stats">
					{(
						[
							["輸入", usage.input],
							["輸出", usage.output],
							["快取讀", usage.cacheRead],
							["快取寫", usage.cacheWrite],
						] as const
					).map(([label, value]) => (
						<div key={label}>
							<dt>{label}</dt>
							<dd>{formatTokens(value)}</dd>
						</div>
					))}
					{(usage.cacheRead > 0 || usage.cacheWrite > 0) && cacheHitRate !== undefined ? (
						<div>
							<dt>快取命中</dt>
							<dd>{cacheHitRate.toFixed(1)}%</dd>
						</div>
					) : null}
			</dl>
				</>
			) : null}
		</div>
	);
}
