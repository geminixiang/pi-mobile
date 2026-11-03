import { useEffect, useState } from "react";
import type { AgentRuntime } from "../agent/runtime.ts";
import { DAY, HOUR, startOfToday } from "../agent/tools/common.ts";
import { Sheet } from "../app/Sheet.tsx";
import { messageOf } from "../promise.ts";
import type { Item } from "./items.ts";

const WHEN = new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const DAY_ONLY = new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric" });
const TOMORROW_MORNING = DAY + 9 * HOUR;

type Loaded = { state: "loading" } | { state: "found"; item: Item; bot: string } | { state: "gone" };

function due(item: Item, now: number): string {
	if (item.nextAt === undefined) return "未定時間";
	return `${WHEN.format(item.nextAt)} ${item.nextAt < now ? "已過期" : "到期"}`;
}

export function ItemSheet({ runtime, id, onAsk, onClose }: { runtime: AgentRuntime; id: string | undefined; onAsk: (text: string) => void; onClose: () => void }) {
	const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
	const [problem, setProblem] = useState<string>();
	useEffect(() => {
		if (id === undefined) return;
		let live = true;
		setLoaded({ state: "loading" });
		setProblem(undefined);
		void Promise.all([runtime.triggers.item(id), runtime.bots()]).then(([item, bots]) => {
			if (!live) return;
			const bot = item && bots.find((candidate) => candidate.id === item.bot);
			setLoaded(item && bot && item.state !== "done" ? { state: "found", item, bot: bot.name } : { state: "gone" });
		});
		return () => {
			live = false;
		};
	}, [runtime, id]);
	const act = (change: Promise<void>) =>
		void change.then(onClose, (error: unknown) => setProblem(messageOf(error)));

	return (
		<Sheet open={id !== undefined} title="待辦" onClose={onClose}>
			{loaded.state === "found" ? (
				<div className="item-card">
					<p className="item-title">{loaded.item.title}</p>
					<p className="list-sub">{`${loaded.bot} · ${due(loaded.item, Date.now())} · ${DAY_ONLY.format(loaded.item.createdAt)} 記下`}</p>
					<div className="item-actions">
						<button
							type="button"
							className="btn primary"
							onClick={() => {
								onAsk(`我們來處理這件事：${loaded.item.title}`);
								onClose();
							}}>
							請 Bot 處理
						</button>
						<button type="button" className="btn" onClick={() => act(runtime.triggers.finishItem(loaded.item.id))}>
							完成了
						</button>
						<button type="button" className="btn" onClick={() => act(runtime.triggers.postponeItem(loaded.item.id, startOfToday() + TOMORROW_MORNING))}>
							明天再說
						</button>
					</div>
					{problem ? <p className="item-problem">{problem}</p> : null}
				</div>
			) : (
				<p className="list-sub">{loaded.state === "loading" ? "讀取中…" : "這件事已經結案了。"}</p>
			)}
		</Sheet>
	);
}
