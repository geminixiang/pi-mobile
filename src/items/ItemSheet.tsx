import type { Bot } from "../agent/bots.ts";
import type { TriggerRuns } from "../triggers/runs.ts";
import { Sheet } from "../ui/Sheet.tsx";
import { ItemActions, remindLine } from "./ItemActions.tsx";
import type { Item } from "./items.ts";
import { useLoaded } from "../ui/loaded.ts";

const DAY_ONLY = new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric" });

type Loaded = { state: "loading" } | { state: "found"; item: Item; bot: string } | { state: "gone" };

const LOADING: Loaded = { state: "loading" };

export function ItemSheet({ runs, bots, id, onDraft, onClose }: { runs: TriggerRuns; bots: () => Promise<readonly Bot[]>; id: string | undefined; onDraft: (conversation: Item["bot"], text: string) => void; onClose: () => void }) {
	const find = async (wanted: string): Promise<Loaded> => {
		const [item, all] = await Promise.all([runs.item(wanted), bots()]);
		const bot = item && all.find((candidate) => candidate.id === item.bot);
		return item && bot && item.state !== "done" ? { state: "found", item, bot: bot.name } : { state: "gone" };
	};
	const loaded = useLoaded(id === undefined ? undefined : () => find(id), [runs, id]).value ?? LOADING;

	return (
		<Sheet open={id !== undefined} title={loaded.state === "found" ? `${loaded.bot}${loaded.item.state === "waiting" ? "正在等" : "提醒你"}` : "待辦"} onClose={onClose}>
			{loaded.state === "found" ? (
				<div className="item-card">
					<p className="item-title">{loaded.item.title}</p>
					{loaded.item.state === "waiting" ? <p className="item-detail">{loaded.item.waitingOn}</p> : null}
					<p className="list-sub">{`${remindLine(loaded.item, Date.now())} · ${DAY_ONLY.format(loaded.item.createdAt)} 記下`}</p>
					<ItemActions runs={runs} item={loaded.item} onDraft={(text) => onDraft(loaded.item.bot, text)} onDone={onClose} />
				</div>
			) : (
				<p className="list-sub">{loaded.state === "loading" ? "讀取中…" : "這件事已經結案了。"}</p>
			)}
		</Sheet>
	);
}
