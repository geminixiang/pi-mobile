import { useEffect, useState } from "react";
import type { AgentRuntime } from "../agent/runtime.ts";
import { Sheet } from "../app/Sheet.tsx";
import { ItemActions } from "./ItemActions.tsx";
import type { Item } from "./items.ts";

const WHEN = new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const DAY_ONLY = new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric" });

type Loaded = { state: "loading" } | { state: "found"; item: Item; bot: string } | { state: "gone" };

export function due(item: Item, now: number): string {
	if (item.nextAt === undefined) return "未定時間";
	return `${WHEN.format(item.nextAt)} ${item.nextAt < now ? "已過期" : "到期"}`;
}

export function ItemSheet({ runtime, id, onAsk, onClose }: { runtime: AgentRuntime; id: string | undefined; onAsk: (text: string) => void; onClose: () => void }) {
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
		<Sheet open={id !== undefined} title="待辦" onClose={onClose}>
			{loaded.state === "found" ? (
				<div className="item-card">
					<p className="item-title">{loaded.item.title}</p>
					<p className="list-sub">{`${loaded.bot} · ${due(loaded.item, Date.now())} · ${DAY_ONLY.format(loaded.item.createdAt)} 記下`}</p>
					<ItemActions runtime={runtime} item={loaded.item} onAsk={onAsk} onDone={onClose} />
				</div>
			) : (
				<p className="list-sub">{loaded.state === "loading" ? "讀取中…" : "這件事已經結案了。"}</p>
			)}
		</Sheet>
	);
}
