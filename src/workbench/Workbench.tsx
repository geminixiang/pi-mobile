import type { ConversationId } from "@earendil-works/pi-durable";
import { FileText, Globe, type LucideIcon, SquareTerminal, Table } from "lucide-react";
import { type ReactNode, useMemo, useRef } from "react";
import type { Bot } from "../agent/bots.ts";
import type { AgentRuntime } from "../agent/runtime.ts";
import type { Workspace } from "../agent/sandbox/workspace.ts";
import { BotAvatar } from "../app/BotAvatar.tsx";
import { CLOCK } from "../app/clock.ts";
import { ChevronIcon } from "../app/icons.tsx";
import { callLabel, doing } from "../app/Message.tsx";
import type { Board, Card, Group } from "./board.ts";
import { Stage, type StageActions } from "./Stage.tsx";
import type { Seen } from "./Surface.tsx";
import { isJob } from "../jobs/background.ts";
import { baseName, isHtml } from "../agent/mime.ts";

const GROUP_LABEL: Record<Group, string> = { need: "需要你", moving: "進行中", result: "成果" };

type Look = "web" | "terminal" | "table" | "doc";

const LOOK_ICON: Record<Look, LucideIcon> = { web: Globe, terminal: SquareTerminal, table: Table, doc: FileText };

const TABLE_FILE = /\.(csv|tsv|xlsx?)$/i;

type Face = { look: Look; lines: readonly string[]; name: string; meta: string; verb: boolean };

function faceOf(card: Card): Face {
	switch (card.kind) {
		case "form":
			return { look: "doc", lines: [card.form.request.message], name: card.form.service, meta: card.form.confirm ?? "確認", verb: true };
		case "ask":
			return { look: "doc", lines: [card.question], name: card.draft ? baseName(card.draft.path) : card.question, meta: card.options[0] ?? "回答", verb: true };
		case "item":
			return { look: "doc", lines: [card.item.title], name: card.item.title, meta: "處理", verb: true };
		case "browser":
			return { look: "web", lines: card.handover ? [card.handover] : [], name: "瀏覽器", meta: "接手", verb: card.handover !== undefined };
		case "watch":
			return { look: "terminal", lines: [card.label], name: isJob(card.agent) ? card.label : card.agent, meta: CLOCK.format(card.since), verb: false };
		case "turn": {
			const last = card.steps.at(-1)?.call;
			return { look: "terminal", lines: card.steps.flatMap((step) => (step.call ? [callLabel(step.call.name, step.call.arguments)] : [])).slice(-3), name: last ? doing(last) : "使用工具", meta: "停止", verb: true };
		}
		case "sources":
			return { look: "web", lines: card.sources.map((source) => source.title).slice(0, 3), name: "來源", meta: `${card.sources.length} 個網頁`, verb: false };
		case "file":
			return { look: isHtml(card.path) ? "web" : TABLE_FILE.test(card.path) ? "table" : "doc", lines: [card.title, card.summary].filter((line) => line && line !== baseName(card.path)), name: baseName(card.path), meta: card.living ? `看板 · ${card.living.schedule}` : card.title === baseName(card.path) ? "" : card.title, verb: false };
	}
}

function TrayCard({ card, on, onShow }: { card: Card; on: boolean; onShow: () => void }) {
	const face = faceOf(card);
	const Icon = LOOK_ICON[face.look];
	return (
		<button type="button" className={`tray-card${on ? " on" : ""}`} onClick={onShow}>
			<span className={`tray-thumb look-${face.look}`}>
				<Icon size={16} strokeWidth={1.6} />
				{face.lines.map((line) => (
					<span key={line} className="tray-line">
						{line}
					</span>
				))}
				{on ? <span className="tray-on">舞台</span> : null}
			</span>
			<span className="tray-name">{face.name}</span>
			{face.meta ? <span className={`tray-meta${face.verb ? " verb" : ""}`}>{face.meta}</span> : null}
		</button>
	);
}

function summaryOf(board: Board): readonly string[] {
	const count = (group: Group) => board.tray.find((section) => section.group === group)?.cards.length ?? 0;
	const busy = [count("need") > 0 ? `${count("need")} 需要你` : "", count("moving") > 0 ? `${count("moving")} 進行中` : ""].filter(Boolean);
	if (busy.length > 0) return busy;
	return board.next ? [`下一次 ${CLOCK.format(board.next.at)} ${board.next.name}`] : [];
}

export function Workbench({
	bot,
	board,
	runtime,
	conversation,
	load,
	info,
	onInfo,
	onCloseInfo,
	picked,
	actions,
}: {
	bot: Bot | undefined;
	board: Board;
	runtime: AgentRuntime;
	conversation: ConversationId;
	load: () => Promise<Workspace | undefined>;
	info: ReactNode | undefined;
	onInfo: () => void;
	onCloseInfo: () => void;
	picked: { path: string; text: string } | undefined;
	actions: StageActions;
}) {
	const looked = useRef(new Map<string, string>());
	const seen = useMemo<Seen>(() => ({ get: (path) => looked.current.get(path), set: (path, text) => void looked.current.set(path, text) }), []);
	return (
		<section className="bench" aria-label="工作台">
			<div className="bench-head">
				<button type="button" className="bench-who" aria-expanded={info !== undefined} onClick={info === undefined ? onInfo : onCloseInfo}>
					{bot ? <BotAvatar bot={bot} size={24} /> : null}
					<span className="bench-name">{bot?.name ?? "Bot"}</span>
					<ChevronIcon open size={12} />
				</button>
				<span className="bench-count">
					{summaryOf(board).map((part) => (
						<span key={part}>{part}</span>
					))}
				</span>
			</div>
				<Stage key={board.stage?.key} board={board} runtime={runtime} conversation={conversation} load={load} seen={seen} picked={picked} actions={actions} />
			{board.tray.length > 0 ? (
				<div className="tray">
					{board.tray.map((section) => (
						<section key={section.group} className="tray-group">
							<h3 className="tray-label">{GROUP_LABEL[section.group]}</h3>
							<div className="tray-cards">
								{section.cards.map((card) => (
									<TrayCard key={card.key} card={card} on={card.key === board.stage?.key} onShow={() => actions.show(card.key)} />
								))}
							</div>
						</section>
					))}
				</div>
			) : null}
			{info !== undefined ? (
				<>
					<button type="button" className="bench-scrim" aria-label="關閉" onClick={onCloseInfo} />
					<div className="bench-info" role="dialog" aria-label={`${bot?.name ?? "Bot"} 的資訊`}>
						{info}
					</div>
				</>
			) : null}
		</section>
	);
}
