import { useEffect, useState } from "react";
import type { AgentRuntime } from "../agent/runtime.ts";
import { Sheet } from "../app/Sheet.tsx";
import { ItemActions, remindLine } from "./ItemActions.tsx";
import type { Item } from "./items.ts";

const DAY_ONLY = new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric" });

type Loaded = { state: "loading" } | { state: "found"; item: Item; bot: string } | { state: "gone" };

export function ItemSheet({ runtime, id, onDraft, onClose }: { runtime: AgentRuntime; id: string | undefined; onDraft: (conversation: Item["bot"], text: string) => void; onClose: () => void }) {
	const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
	useEffect(() => {
		if (id === undefined) return;
		let live = true;
		setLoaded({ state: "loading" });
		void Promise.all([runtime.triggers.item(id), runtime.bots()]).then(([item, bots]) => {
			if (!live) return;
			const bot = item && bots.find((candidate) => candidate.id === item.bot);
			setLoaded(item && bot && item.state !== "done" ? { state: "found", item, bot: bot.name } : { state: "gone" });
		});
		return () => {
			live = false;
		};
	}, [runtime, id]);

	return (
		<Sheet open={id !== undefined} title={loaded.state === "found" ? `${loaded.bot}${loaded.item.state === "waiting" ? "正在等" : "提醒你"}` : "待辦"} onClose={onClose}>
			{loaded.state === "found" ? (
				<div className="item-card">
					<p className="item-title">{loaded.item.title}</p>
					{loaded.item.state === "waiting" ? <p className="item-detail">{loaded.item.waitingOn}</p> : null}
					<p className="list-sub">{`${remindLine(loaded.item, Date.now())} · ${DAY_ONLY.format(loaded.item.createdAt)} 記下`}</p>
					<ItemActions runtime={runtime} item={loaded.item} onDraft={(text) => onDraft(loaded.item.bot, text)} onDone={onClose} />
				</div>
			) : (
				<p className="list-sub">{loaded.state === "loading" ? "讀取中…" : "這件事已經結案了。"}</p>
			)}
		</Sheet>
	);
}
