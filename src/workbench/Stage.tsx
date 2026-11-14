import type { ConversationId } from "@earendil-works/pi-durable";
import { type ReactNode, useEffect, useState } from "react";
import type { FormAnswer } from "../agent/mcp-stateless.ts";
import type { AgentRuntime } from "../agent/runtime.ts";
import type { Workspace } from "../agent/sandbox/workspace.ts";
import { CLOCK } from "../app/clock.ts";
import { CloseIcon } from "../app/icons.tsx";
import { useLoaded } from "../app/loaded.ts";
import { callLabel, doing } from "../app/Message.tsx";
import { resolvePath } from "../app/openFile.ts";
import { WorkspaceView } from "../app/WorkspaceView.tsx";
import { Browser } from "../browser/plugin.ts";
import { choicesOf } from "../computer-agents/workers.ts";
import { ItemActions } from "../items/ItemActions.tsx";
import { due } from "../items/ItemSheet.tsx";
import { clock, useNow } from "../jobs/JobsContext.ts";
import { orLogged } from "../promise.ts";
import { type Board, type Card, type Draft, hostOf, type Source } from "./board.ts";
import { type Seen, Surface } from "./Surface.tsx";
import { isJob } from "../jobs/background.ts";
import { baseName } from "../agent/mime.ts";

const PEEK_EVERY_MS = 1500;
const SHOT_EVERY_MS = 2000;
const TAIL_LINES = 12;

export type StageActions = {
	close: (key: string) => void;
	show: (key: string) => void;
	ask: (text: string) => void;
	reply: (text: string) => void;
	answerForm: (callId: string, answer: FormAnswer) => void;
	stopTurn: () => void;
	browser: () => void;
	openUrl: (url: string) => void;
	pick: (path: string, text: string) => void;
};

type StageProps = {
	board: Board;
	runtime: AgentRuntime;
	conversation: ConversationId;
	load: () => Promise<Workspace | undefined>;
	seen: Seen;
	picked: { path: string; text: string } | undefined;
	actions: StageActions;
};

const tail = (text: string) =>
	text
		.split("\n")
		.filter((line) => line.trim())
		.slice(-TAIL_LINES)
		.join("\n");

function labelOf(card: Card, queue: Board["queue"]): string {
	const place = queue && queue.total > 1 ? ` · ${queue.at}/${queue.total}` : "";
	switch (card.kind) {
		case "form":
			return `需要你 · ${card.form.service}${place}`;
		case "ask":
			return `需要你${card.draft ? ` · ${baseName(card.draft.path)}` : ""}${place}`;
		case "item":
			return `需要你 · 待辦${place}`;
		case "browser":
			return card.handover === undefined ? "進行中 · 瀏覽器" : `需要你 · 瀏覽器${place}`;
		case "watch":
			return isJob(card.agent) ? "進行中 · 背景指令" : `進行中 · ${card.agent}`;
		case "turn":
			return "進行中 · 這一輪";
		case "sources":
			return `來源 · ${card.sources.length}`;
		case "file":
			return card.living ? `看板 · ${card.living.schedule}${card.living.at === undefined ? "" : ` · ${CLOCK.format(card.living.at)} 更新`}` : `成果 · ${baseName(card.path)}`;
	}
}

function titleOf(card: Card): string {
	switch (card.kind) {
		case "form":
			return card.form.request.message;
		case "ask":
			return card.question;
		case "item":
			return card.item.title;
		case "browser":
			return card.handover ?? "Bot 的瀏覽器";
		case "watch":
			return card.label;
		case "turn": {
			const last = card.steps.at(-1)?.call;
			return last ? doing(last) : "使用工具";
		}
		case "sources":
			return "這一輪讀過的網頁";
		case "file":
			return card.title === baseName(card.path) ? "" : card.title;
	}
}

export function Stage(props: StageProps) {
	const { board, actions } = props;
	const card = board.stage;
	if (!card) return <div className="stage stage-empty">閒著</div>;
	if (card.kind === "folder") {
		return (
			<div className="stage stage-folder">
				<WorkspaceView load={props.load} initial={{ tab: "files" }} onClose={() => actions.close(card.key)} onOpenFile={(path) => actions.show(`file:${path}`)} />
			</div>
		);
	}
	const title = titleOf(card);
	return (
		<div className={`stage stage-${card.group}`}>
			<div className="stage-meta">
				<span className="stage-label">{labelOf(card, board.queue)}</span>
				{board.pinned ? (
					<button type="button" className="stage-close" aria-label="收起" onClick={() => actions.close(card.key)}>
						<CloseIcon size={14} />
					</button>
				) : null}
			</div>
			{title ? <h2 className="stage-title">{title}</h2> : null}
			<StageBody card={card} {...props} />
		</div>
	);
}

function Next({ board, actions }: Pick<StageProps, "board" | "actions">) {
	const needs = board.tray.find((section) => section.group === "need")?.cards ?? [];
	const queue = board.queue;
	const next = queue && queue.total > 1 ? needs[queue.at % needs.length] : undefined;
	return next ? (
		<button type="button" className="stage-skip" onClick={() => actions.show(next.key)}>
			下一件
		</button>
	) : null;
}

function StageBody(props: StageProps & { card: Card }) {
	const { card, board, runtime, conversation, actions } = props;
	switch (card.kind) {
		case "form": {
			const fields = Object.entries(card.form.request.schema.properties);
			const confirmable = fields.every(([, field]) => field.type === "boolean");
			return (
				<Bar>
					<span className="inline-verbs">
						{confirmable ? (
							<button type="button" className="primary" onClick={() => actions.answerForm(card.callId, { action: "accept", content: Object.fromEntries(fields.map(([key]) => [key, true])) })}>
								{card.form.confirm ?? "確認"}
							</button>
						) : null}
						<button type="button" onClick={() => actions.answerForm(card.callId, { action: "decline" })}>
							取消
						</button>
					</span>
					<Next board={board} actions={actions} />
				</Bar>
			);
		}
		case "ask": {
			const options = (
				<span className="inline-verbs">
					{card.options.map((option, index) => (
						<button key={option} type="button" className={index === 0 ? "primary" : undefined} onClick={() => actions.reply(option)}>
							{option}
						</button>
					))}
					<Next board={board} actions={actions} />
				</span>
			);
			return card.draft ? <DraftSurface draft={card.draft} {...props} actions={actions} bar={options} /> : <Bar>{options}</Bar>;
		}
		case "item":
			return (
				<>
					<p className="stage-line">{due(card.item, Date.now())}</p>
					<Bar>
						<ItemActions runtime={runtime} item={card.item} onAsk={actions.ask} onDone={() => undefined} />
						<Next board={board} actions={actions} />
					</Bar>
				</>
			);
		case "browser":
			return <BrowserLive bot={String(conversation)} handover={card.handover !== undefined} onOpen={actions.browser} />;
		case "watch":
			return <AgentControl runtime={runtime} conversation={conversation} agent={card.agent} since={card.since} onAsk={actions.ask} />;
		case "turn":
			return <TurnControl card={card} onStop={actions.stopTurn} />;
		case "sources":
			return <SourceList sources={card.sources} onOpen={actions.openUrl} />;
		case "file":
			return <DraftSurface draft={{ path: card.path, version: card.version, previous: card.previous }} {...props} bar={null} />;
	}
}

function Bar({ children }: { children: ReactNode }) {
	return <div className="stage-verbs">{children}</div>;
}

function DraftSurface({ draft, load, seen, picked, actions, bar }: StageProps & { draft: Draft; bar: ReactNode }) {
	const { value: workspace, error } = useLoaded(async () => (await load()) ?? null, [load]);
	if (error) return <div className="banner error">{error}</div>;
	if (workspace === undefined) return <div className="ws-loading">讀取中</div>;
	if (workspace === null) return <div className="ws-empty">還沒有資料夾</div>;
	const path = resolvePath(workspace.root, draft.path);
	return (
		<Surface
			workspace={workspace}
			path={path}
			version={draft.version}
			previous={draft.previous}
			seen={seen}
			picked={picked?.path === draft.path ? picked.text : undefined}
			onPick={(text) => actions.pick(draft.path, text)}
			actions={bar}
		/>
	);
}

function TurnControl({ card, onStop }: { card: Extract<Card, { kind: "turn" }>; onStop: () => void }) {
	const running = card.steps.findLast((step) => step.status !== "done") ?? card.steps.at(-1);
	const command = running?.call ? (typeof running.call.arguments.code === "string" ? running.call.arguments.code : `› ${callLabel(running.call.name, running.call.arguments)}`) : "";
	return (
		<>
			<pre className="stage-terminal">{[tail(command), tail(running?.output ?? "")].filter(Boolean).join("\n\n")}</pre>
			<Bar>
				<span className="inline-verbs">
					<button type="button" className="danger" onClick={onStop}>
						停止
					</button>
				</span>
				<span className="stage-aside">{`${card.steps.length} 步`}</span>
			</Bar>
		</>
	);
}

type Screen = { state: "loading" } | { state: "read"; text: string; doing: string; waiting: boolean } | { state: "gone" };

function AgentControl({ runtime, conversation, agent, since, onAsk }: { runtime: AgentRuntime; conversation: ConversationId; agent: string; since: number; onAsk: (text: string) => void }) {
	const now = useNow(true);
	const [screen, setScreen] = useState<Screen>({ state: "loading" });
	const [stopping, setStopping] = useState<"idle" | "stopping" | "failed">("idle");
	useEffect(() => {
		let live = true;
		const read = async () => {
			const reading = await orLogged(runtime.peekAgent(conversation, agent), "workbench.peek_failed", undefined, { agent });
			if (!live) return;
			setScreen(reading?.ok ? { state: "read", text: reading.screen, doing: reading.doing, waiting: reading.status === "needs_user" } : { state: "gone" });
		};
		void read();
		const timer = setInterval(() => void read(), PEEK_EVERY_MS);
		return () => {
			live = false;
			clearInterval(timer);
		};
	}, [runtime, conversation, agent]);
	const stop = async () => {
		setStopping("stopping");
		try {
			await runtime.stopJob(conversation, agent);
		} catch {
			setStopping("failed");
		}
	};
	const job = isJob(agent);
	const choices = screen.state === "read" && screen.waiting ? choicesOf(screen.text) : undefined;
	return (
		<>
			<p className="stage-line">
				{screen.state === "read" ? screen.doing || (screen.waiting ? "等你回答" : "執行中") : screen.state === "loading" ? "讀取中…" : "讀不到它的畫面"}
				<span className="stage-aside">{` · ${clock(now - since)}`}</span>
			</p>
			{screen.state === "read" ? <pre className="stage-terminal">{tail(screen.text) || "（還沒有輸出）"}</pre> : null}
			<Bar>
				<span className="inline-verbs">
					{choices?.options.map((option) => (
						<button key={option} type="button" onClick={() => onAsk(`請 ${agent} 選「${option}」`)}>
							{option}
						</button>
					))}
					{job ? (
						<button type="button" className="danger" disabled={stopping === "stopping"} onClick={() => void stop()}>
							{stopping === "stopping" ? "停止中" : stopping === "failed" ? "停不下來，再按一次" : "停止"}
						</button>
					) : null}
				</span>
			</Bar>
		</>
	);
}

function BrowserLive({ bot, handover, onOpen }: { bot: string; handover: boolean; onOpen: () => void }) {
	const [shot, setShot] = useState<string>();
	useEffect(() => {
		let live = true;
		const peek = async () => {
			const peeked = await orLogged(Browser.peek({ bot }), "workbench.browser_peek_failed", undefined);
			if (live && peeked?.jpeg) setShot(peeked.jpeg);
		};
		void peek();
		const timer = setInterval(() => void peek(), SHOT_EVERY_MS);
		return () => {
			live = false;
			clearInterval(timer);
		};
	}, [bot]);
	return (
		<>
			<div className="stage-shot">{shot ? <img src={`data:image/jpeg;base64,${shot}`} alt="" /> : null}</div>
			<Bar>
				<span className="inline-verbs">
					<button type="button" className="primary" onClick={onOpen}>
						{handover ? "接手" : "接手瀏覽器"}
					</button>
				</span>
			</Bar>
		</>
	);
}

function SourceList({ sources, onOpen }: { sources: readonly Source[]; onOpen: (url: string) => void }) {
	const [open, setOpen] = useState<string | undefined>(sources[0]?.url);
	return (
		<ol className="stage-sources">
			{sources.map((source) => (
				<li key={source.url} className={source.url === open ? "open" : undefined}>
					<button type="button" className="source-head" aria-expanded={source.url === open} onClick={() => setOpen(source.url === open ? undefined : source.url)}>
						<span className="source-title">{source.title}</span>
						<span className="source-host">{hostOf(source.url)}</span>
					</button>
					{source.url === open ? (
						<>
							{source.read ? <pre className="source-read">{source.read}</pre> : null}
							<span className="inline-verbs">
								<button type="button" onClick={() => onOpen(source.url)}>
									用瀏覽器開
								</button>
							</span>
						</>
					) : null}
				</li>
			))}
		</ol>
	);
}
