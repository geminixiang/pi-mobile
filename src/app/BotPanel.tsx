import type { ConversationId, ConversationView } from "@earendil-works/pi-durable";
import { type ReactNode, useEffect, useState } from "react";
import type { Bot } from "../agent/bots.ts";
import type { AgentRuntime } from "../agent/runtime.ts";
import type { TriggerState } from "../triggers/runs.ts";
import type { Computer } from "../agent/workplaces.ts";
import type { ToolsetState } from "../agent/toolsets.ts";
import { BotAvatar } from "./BotAvatar.tsx";
import { ContextCard } from "./ContextCard.tsx";
import { PrepareStatus, usePrepare } from "./HostsGroup.tsx";
import { CheckIcon, ChevronIcon, PencilIcon } from "./icons.tsx";
import { Sheet } from "./Sheet.tsx";
import { TriggerList } from "../triggers/TriggerList.tsx";
import { messageOf } from "../promise.ts";
import { useBriefly } from "./briefly.ts";
import { native } from "../native.ts";
import { Abilities } from "./Abilities.tsx";
import { HostRow, type LinkNode, LinksSection, PhoneSheet } from "./Links.tsx";
import { ModelSheet } from "./ModelSheet.tsx";
import { Container, Monitor, Smartphone } from "lucide-react";
import { parseComputerKey } from "../agent/sandbox/host.ts";

type ModelChange = { model?: { provider: string; id: string }; thinking?: string };
type PanelModel = { provider: string; id: string; name: string; thinking: string };

interface PanelActions {
	model: (change: ModelChange) => void;
	edit: () => void;
	ask: (text: string) => void;
	memory: () => void;
	compact: () => Promise<boolean>;
	reset: () => void;
	emptyFolder?: () => Promise<boolean>;
}


function PlaceIcon({ computer }: { computer: Computer }) {
	const Icon = computer.key === "phone" ? Smartphone : parseComputerKey(computer.key)?.mode === "container" ? Container : Monitor;
	return (
		<span className="place-icon" aria-hidden="true">
			<Icon size={20} strokeWidth={1.6} />
		</span>
	);
}

function LinkSheets({
	runtime,
	bot,
	open,
	model,
	onModel,
	onClose,
	reload,
	onError,
}: {
	runtime: AgentRuntime;
	bot: Bot;
	open: LinkNode | undefined;
	model: PanelModel;
	onModel: (change: ModelChange) => void;
	onClose: () => void;
	reload: (id: ConversationId) => void;
	onError: (message: string) => void;
}) {
	const place = runtime.workplaces.at(String(bot.id));
	const key = place?.kind === "computer" ? place.computer.key : place?.kind === "missing" ? place.key : "phone";
	const container = place?.kind === "computer" && !place.sandbox.direct ? place.host : undefined;
	const [preparing, prepare] = usePrepare(container);
	const offers = runtime.workplaces.offers(String(bot.id));
	const places = offers ? runtime.workplaces.list() : [];
	const choose = async (next: string) => {
		await runtime.setComputer(bot.id, next);
		reload(bot.id);
		const chosen = runtime.workplaces.at(String(bot.id));
		if (chosen?.kind === "computer" && !chosen.sandbox.direct) await prepare(chosen.host);
	};
	const list = (shown: readonly Computer[]) => (
		<div className="menu choice-list">
			{shown.map((computer) => (
				<button
					type="button"
					key={computer.key}
					className={computer.key === key ? "selected" : ""}
					onClick={() => {
						onClose();
						void choose(computer.key).catch((error: unknown) => onError(`切換電腦失敗：${messageOf(error)}`));
					}}
				>
					<PlaceIcon computer={computer} />
					<span className="menu-text">
						{computer.name}
						{computer.key === "phone" ? null : <span className="menu-hint">{computer.mode}</span>}
					</span>
					{computer.key === key ? <CheckIcon size={16} /> : null}
				</button>
			))}
		</div>
	);
	return (
		<>
			<PrepareStatus preparing={preparing} />
			<ModelSheet
				open={open === "model"}
				models={runtime.models}
				current={{ provider: model.provider, id: model.id }}
				thinking={model.thinking}
				onClose={onClose}
				onChange={(change) => {
					onModel(change);
					if (change.model) onClose();
				}}
			/>
			<PhoneSheet open={open === "phone"} onClose={onClose} />
			<Sheet open={open === "computer"} title="電腦" onClose={onClose}>
				{place?.kind === "computer" ? (
					<div className="link-rows">
						<HostRow name={place.computer.name} mode={place.computer.mode} sandbox={place.sandbox} />
					</div>
				) : null}
				{places.length > 0 ? (
					<>
						<div className="strip-label">在哪裡跑</div>
						{list(places)}
					</>
				) : null}
			</Sheet>
		</>
	);
}

function Section({ title, problem, children }: { title: string; problem?: Problem; children: ReactNode }) {
	return (
		<section className="panel-section">
			<h3 className="strip-label">{title}</h3>
			{children}
			{problem?.section === title ? <div className="note error">{problem.text}</div> : null}
		</section>
	);
}

type Problem = { section: string; text: string };

export function BotPanel({
	open,
	bot,
	runtime,
	view,
	context,
	compactAt,
	model,
	busy,
	actions,
	onClose,
}: {
	open: boolean;
	bot: Bot | undefined;
	runtime: AgentRuntime;
	view: ConversationView | undefined;
	context: { used: number; window: number };
	compactAt: number;
	model: PanelModel;
	busy: boolean;
	actions: PanelActions;
	onClose: () => void;
}) {
	const [problem, setProblem] = useState<Problem>();
	const [compacting, setCompacting] = useState(false);
	const [compacted, showCompacted] = useBriefly();
	const [emptied, showEmptied] = useBriefly();
	const [linkSheet, setLinkSheet] = useState<LinkNode>();
	useEffect(() => {
		if (!open) setProblem(undefined);
	}, [open]);
	const failIn = (section: string) => (error: unknown) => setProblem({ section, text: messageOf(error) });
	const [triggers, setTriggers] = useState<TriggerState>({ items: [], next: {} });
	const [memory, setMemory] = useState("");
	useEffect(() => runtime.triggers.subscribe(setTriggers), [runtime]);
	const botId = bot?.id;
	useEffect(() => (botId === undefined ? undefined : runtime.subscribeMemory({ kind: "bot", id: botId }, (next) => setMemory(next.text))), [runtime, botId]);
	const [toolsets, setToolsets] = useState<ToolsetState[]>([]);
	const reload = (id: ConversationId) => runtime.toolsets(id).then(setToolsets);
	useEffect(() => {
		if (botId === undefined || !open) return;
		let live = true;
		void runtime.toolsets(botId).then((next) => {
			if (live) setToolsets(next);
		});
		return () => {
			live = false;
		};
	}, [runtime, botId, open]);
	if (!bot) return null;

	const toggle = (id: string, enabled: boolean) => {
		setToolsets((current) => current.map((toolset) => (toolset.id === id ? { ...toolset, enabled } : toolset)));
		runtime
			.setToolset(bot.id, id, enabled)
			.then(() => reload(bot.id))
			.catch((error: unknown) => setProblem({ section: "能做什麼", text: `設定失敗：${messageOf(error)}` }));
	};

	const run = (action: () => void) => () => {
		onClose();
		action();
	};
	const mine = triggers.items.filter((item) => item.conversationId === bot.id);
	const memoryCount = memory.split("\n").filter((line) => line.trim()).length;

	return (
		<div className="panel">
			<button type="button" className="panel-bot" onClick={run(actions.edit)}>
				<BotAvatar bot={bot} size={48} />
				<span className="panel-bot-text">
					<span className="panel-bot-name">
						{bot.name}
						<PencilIcon size={14} />
					</span>
					<span className="panel-bot-job">{bot.job || "一般助理"}</span>
				</span>
			</button>
			<LinksSection live={open} provider={model.provider} model={model.name} busy={busy} place={runtime.workplaces.at(String(bot.id))} onOpen={setLinkSheet}>
				<LinkSheets
					runtime={runtime}
					bot={bot}
					open={linkSheet}
					model={model}
					onModel={actions.model}
					onClose={() => setLinkSheet(undefined)}
					reload={reload}
					onError={(text) => setProblem({ section: "連線", text })}
				/>
				{problem?.section === "連線" ? <span className="note error">{problem.text}</span> : null}
			</LinksSection>

			<Section title="能做什麼" problem={problem}>
				<Abilities
					toolsets={toolsets}
					onToggle={toggle}
					onAsk={(text) => {
						onClose();
						actions.ask(text);
					}}
				/>
			</Section>

			<Section title="上下文" problem={problem}>
				<ContextCard runtime={runtime} botId={bot.id} open={open} view={view} context={context} compactAt={compactAt} />
				<div className="inline-verbs">
					<button
						type="button"
						disabled={compacting}
						onClick={() => {
							setCompacting(true);
							void actions
								.compact()
								.then((done) => showCompacted(done ? "已壓縮" : "還不用壓縮"), failIn("上下文"))
								.finally(() => setCompacting(false));
						}}
					>
						{compacting ? "壓縮中…" : (compacted ?? "壓縮")}
					</button>
					<button type="button" onClick={run(actions.reset)}>
						新的上下文
					</button>
				</div>
			</Section>

			{native.has("Triggers") && mine.length > 0 ? (
				<div className="trigger-panel">
					<TriggerList triggers={mine} next={triggers.next} runtime={runtime} onError={(text) => setProblem({ section: "自動化", text })} />
					{problem?.section === "自動化" ? <div className="note error">{problem.text}</div> : null}
				</div>
			) : null}

			<Section title="其他" problem={problem}>
				<div className="panel-rows">
					<button type="button" onClick={actions.memory}>
						<span className="menu-text">記憶</span>
						<span className="index-value">{memoryCount > 0 ? `${memoryCount} 條` : "還沒有"}</span>
						<ChevronIcon />
					</button>
				</div>
			</Section>

			{actions.emptyFolder ? (
				<button type="button" className="danger-verb" onClick={() => void actions.emptyFolder?.().then((done) => done && showEmptied("已清空"), failIn("其他"))}>
					{emptied ?? "清空資料夾"}
				</button>
			) : null}
		</div>
	);
}
