import type { ConversationId } from "@earendil-works/pi-durable";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentRuntime } from "../agent/runtime.ts";
import type { Workspace } from "../agent/sandbox/workspace.ts";
import { FileViewer } from "../app/FileViewer.tsx";
import { CloseIcon } from "../app/icons.tsx";
import { useLoaded } from "../app/loaded.ts";
import { callLabel, doing } from "../app/Message.tsx";
import { resolvePath } from "../app/openFile.ts";
import { WorkspaceView } from "../app/WorkspaceView.tsx";
import { CLOCK } from "../app/clock.ts";
import { Browser } from "../browser/plugin.ts";
import { FormCard } from "../interaction/FormCard.tsx";
import { QuestionCard } from "../interaction/QuestionCard.tsx";
import { ItemActions } from "../items/ItemActions.tsx";
import { due } from "../items/ItemSheet.tsx";
import { useNow } from "../jobs/JobsContext.ts";
import { messageOf, orLogged } from "../promise.ts";
import { MINUTE, startOfToday } from "../time.ts";
import { lastRun } from "../triggers/TriggerRow.tsx";
import { clockOf, describeAgo, describeRule, describeWhen } from "../triggers/when.ts";
import { type Card, nameOf, type Staged, type Step } from "./board.ts";

const PEEK_EVERY_MS = 1500;
const SHOT_EVERY_MS = 2000;

export type StageActions = {
	close: (key: string) => void;
	show: (key: string) => void;
	ask: (text: string) => void;
	browser: () => void;
};

type Heading = { label: string; title: string; aside?: string };

function untilText(at: number, now: number): string {
	const minutes = Math.max(0, Math.round((at - now) / MINUTE));
	if (minutes < 60) return `${minutes} 分後`;
	const hours = Math.floor(minutes / 60);
	return hours >= 24 ? `${Math.floor(hours / 24)} 天後` : `${hours} 小時${minutes % 60 ? ` ${minutes % 60} 分` : ""}後`;
}

function headingOf(card: Card, now: number): Heading {
	switch (card.kind) {
		case "form":
			return { label: "需要你", title: card.form.service };
		case "ask":
			return { label: "需要你 · 問題", title: "" };
		case "item":
			return { label: "需要你 · 待辦", title: card.item.title, aside: due(card.item, now) };
		case "browser":
			return { label: card.handover === undefined ? "即時畫面 · 瀏覽器" : "需要你 · 瀏覽器", title: card.handover ?? "瀏覽器" };
		case "watch":
			return { label: card.agent.startsWith("job:") ? "電腦 · 背景指令" : `電腦 · ${card.agent}`, title: card.label, aside: CLOCK.format(card.since) };
		case "turn": {
			const last = card.steps.at(-1)?.call;
			return { label: "進行中 · 這一輪", title: last ? doing(last) : "使用工具", aside: `${card.steps.length} 步` };
		}
		case "file":
			return { label: `成果 · ${nameOf(card.path)}`, title: card.title === nameOf(card.path) ? "" : card.title };
		case "schedule":
			return { label: `已排定 · ${describeRule(card.trigger.when) ?? describeWhen(card.trigger.when)}`, title: card.trigger.name, aside: card.at === undefined ? undefined : untilText(card.at, now) };
		case "due":
			return { label: "已排定 · 待辦", title: card.item.title, aside: untilText(card.at, now) };
	}
}

export function Stage({
	card,
	pinned,
	runtime,
	conversation,
	load,
	actions,
}: {
	card: Staged | undefined;
	pinned: boolean;
	runtime: AgentRuntime;
	conversation: ConversationId;
	load: () => Promise<Workspace | undefined>;
	actions: StageActions;
}) {
	const now = useNow(card?.kind === "schedule" || card?.kind === "due");
	if (!card) return <div className="stage stage-empty">還沒有工作</div>;
	if (card.kind === "folder") {
		return (
			<div className="stage stage-folder">
				<StageBody card={card} runtime={runtime} conversation={conversation} load={load} actions={actions} />
			</div>
		);
	}
	const heading = headingOf(card, now);
	return (
		<div className={`stage stage-${card.kind}`}>
			<div className="stage-meta">
				<span className="stage-label">{heading.label}</span>
				{heading.aside ? <span className="stage-aside">{heading.aside}</span> : null}
				{pinned ? (
					<button type="button" className="stage-close" aria-label="收起" onClick={() => actions.close(card.key)}>
						<CloseIcon size={14} />
					</button>
				) : null}
			</div>
			{heading.title ? <h2 className="stage-title">{heading.title}</h2> : null}
			<StageBody card={card} runtime={runtime} conversation={conversation} load={load} actions={actions} />
		</div>
	);
}

function StageBody({ card, runtime, conversation, load, actions }: { card: Staged; runtime: AgentRuntime; conversation: ConversationId; load: () => Promise<Workspace | undefined>; actions: StageActions }) {
	switch (card.kind) {
		case "folder":
			return <WorkspaceView load={load} initial={{ tab: "files" }} onClose={() => actions.close(card.key)} onOpenFile={(path) => actions.show(`file:${path}`)} />;
		case "form":
			return <FormCard callId={card.callId} />;
		case "ask":
			return <QuestionCard call={card.call} />;
		case "item":
			return (
				<Verbs>
					<ItemActions runtime={runtime} item={card.item} onAsk={actions.ask} onDone={() => undefined} />
				</Verbs>
			);
		case "browser":
			return <BrowserLive bot={String(conversation)} handover={card.handover !== undefined} onOpen={actions.browser} />;
		case "watch":
			return <AgentScreen runtime={runtime} conversation={conversation} agent={card.agent} />;
		case "turn":
			return <TurnSteps steps={card.steps} />;
		case "file":
			return <FilePane load={load} path={card.path} version={card.version} />;
		case "schedule":
			return <ScheduleView card={card} runtime={runtime} />;
		case "due":
			return (
				<>
					<p className="stage-clock">{clockOf(card.at)}</p>
					{card.item.state === "waiting" ? <p className="stage-line">等 {card.item.waitingOn}</p> : null}
					<Verbs>
						<ItemActions runtime={runtime} item={card.item} onAsk={actions.ask} onDone={() => undefined} />
					</Verbs>
				</>
			);
	}
}

function Verbs({ children }: { children: ReactNode }) {
	return <div className="stage-verbs">{children}</div>;
}

function FilePane({ load, path, version }: { load: () => Promise<Workspace | undefined>; path: string; version: number }) {
	const { value: workspace, error } = useLoaded(async () => (await load()) ?? null, [load]);
	if (error) return <div className="banner error">{error}</div>;
	if (workspace === undefined) return <div className="ws-loading">讀取中</div>;
	if (workspace === null) return <div className="ws-empty">還沒有資料夾</div>;
	return <FileViewer key={version} workspace={workspace} path={resolvePath(workspace.root, path)} frame={{ kind: "stage" }} />;
}

function ScheduleView({ card, runtime }: { card: Extract<Card, { kind: "schedule" }>; runtime: AgentRuntime }) {
	const [problem, setProblem] = useState<string>();
	const { trigger } = card;
	const when = trigger.when;
	const time = card.at !== undefined ? clockOf(card.at) : when.kind === "daily" ? when.time : undefined;
	const act = (action: Promise<unknown>) => void action.catch((failure: unknown) => setProblem(messageOf(failure)));
	return (
		<>
			{time ? <p className="stage-clock">{time}</p> : null}
			{trigger.onlyIf ? <p className="stage-line">只在：{trigger.onlyIf}</p> : null}
			{trigger.last ? (
				<p className={`stage-line${trigger.last.outcome === "failed" ? " error" : ""}`}>{`上一次 ${describeAgo(trigger.last.at, startOfToday())} · ${lastRun(trigger.last)}`}</p>
			) : null}
			<Verbs>
				<span className="inline-verbs">
					<button type="button" onClick={() => act(runtime.triggers.run(trigger.id, "manual"))}>
						立即執行
					</button>
					<button type="button" onClick={() => act(runtime.triggers.setPaused(trigger.id, true))}>
						暫停
					</button>
				</span>
				{problem ? <p className="item-problem">{problem}</p> : null}
			</Verbs>
		</>
	);
}

function TurnSteps({ steps }: { steps: readonly Step[] }) {
	const running = steps.findLast((step) => step.status !== "done");
	return (
		<>
			{steps.length > 1 ? (
			<ol className="stage-steps">
				{steps.map((step) => (
					<li key={step.callId} className={step.status}>
						<span className="stage-step-name">{step.call ? doing(step.call) : step.name}</span>
						<span className="stage-step-label">{step.call ? callLabel(step.call.name, step.call.arguments) : ""}</span>
					</li>
				))}
			</ol>
			) : null}
			{running?.call ? <Terminal text={[typeof running.call.arguments.code === "string" ? running.call.arguments.code : `› ${callLabel(running.call.name, running.call.arguments)}`, running.output].filter(Boolean).join("\n\n")} /> : null}
		</>
	);
}

function Terminal({ text }: { text: string }) {
	const box = useRef<HTMLPreElement>(null);
	useLayoutEffect(() => {
		const element = box.current;
		if (element) element.scrollTop = element.scrollHeight;
	}, [text]);
	return (
		<pre className="stage-terminal" ref={box}>
			{text.trimEnd()}
		</pre>
	);
}

type Screen = { state: "loading" } | { state: "read"; text: string; doing: string } | { state: "gone" };

function AgentScreen({ runtime, conversation, agent }: { runtime: AgentRuntime; conversation: ConversationId; agent: string }) {
	const [screen, setScreen] = useState<Screen>({ state: "loading" });
	const [stopping, setStopping] = useState<"idle" | "stopping" | "failed">("idle");
	useEffect(() => {
		let live = true;
		const read = async () => {
			const reading = await orLogged(runtime.peekAgent(conversation, agent), "workbench.peek_failed", undefined, { agent });
			if (!live) return;
			setScreen(reading?.ok ? { state: "read", text: reading.screen, doing: reading.doing } : { state: "gone" });
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
	return (
		<>
			{screen.state === "read" ? <Terminal text={screen.text || "（還沒有輸出）"} /> : <p className="stage-line">{screen.state === "loading" ? "讀取中…" : "讀不到它的畫面"}</p>}
			<Verbs>
				{agent.startsWith("job:") ? (
					<span className="inline-verbs">
						<button type="button" className="danger" disabled={stopping === "stopping"} onClick={() => void stop()}>
							{stopping === "stopping" ? "停止中" : stopping === "failed" ? "停不下來，再按一次" : "停止"}
						</button>
					</span>
				) : null}
				{screen.state === "read" && screen.doing ? <span className="stage-aside">{screen.doing}</span> : null}
			</Verbs>
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
			<Verbs>
				<span className="inline-verbs">
					<button type="button" className={handover ? "primary" : undefined} onClick={onOpen}>
						{handover ? "接手" : "打開"}
					</button>
				</span>
			</Verbs>
		</>
	);
}
