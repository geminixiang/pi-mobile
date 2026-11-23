import { useState } from "react";
import type { TriggerRuns } from "../triggers/runs.ts";
import { messageOf } from "pi-mobile-base/promise";
import { DAY, HOUR, startOfToday } from "pi-mobile-base/time";
import { describeNear } from "../triggers/when.ts";
import type { Item } from "./items.ts";

const LATER = [
	{ label: "1 小時後", at: (now: number) => now + HOUR },
	{ label: "今晚 9 點", at: (now: number) => (now < startOfToday() + 20 * HOUR ? startOfToday() + 21 * HOUR : undefined) },
	{ label: "明早 9 點", at: () => startOfToday() + DAY + 9 * HOUR },
] as const;

export function remindLine(item: Item, now: number): string {
	const at = item.nextAt === undefined ? undefined : describeNear(item.nextAt, startOfToday());
	if (item.state === "waiting") return at ? `${at} 還沒消息就提醒你` : "等到了就提醒你";
	if (at === undefined) return "沒有定提醒時間";
	return item.nextAt !== undefined && item.nextAt <= now ? `${at} 提醒的` : `${at} 會提醒你`;
}

export function ItemActions({ runs, item, onDraft, onDone }: { runs: TriggerRuns; item: Item; onDraft: (text: string) => void; onDone: () => void }) {
	const [problem, setProblem] = useState<string>();
	const [later, setLater] = useState(false);
	const act = (change: Promise<void>) =>
		void change.then(
			() => {
				setLater(false);
				onDone();
			},
			(error: unknown) => setProblem(messageOf(error)),
		);
	const draft = (text: string) => {
		onDraft(text);
		onDone();
	};
	const now = Date.now();
	return (
		<>
			{item.state === "waiting" ? (
				<div className="item-actions">
					<button type="button" className="btn primary" onClick={() => draft(`「${item.title}」現在怎麼樣了？`)}>
						問進度
					</button>
					<button type="button" className="btn" onClick={() => act(runs.finishItem(item.id))}>
						不用等了
					</button>
				</div>
			) : later ? (
				<div className="item-actions">
					{LATER.flatMap(({ label, at }) => {
						const until = at(now);
						return until === undefined
							? []
							: [
									<button key={label} type="button" className="btn" onClick={() => act(runs.postponeItem(item.id, until))}>
										{label}
									</button>,
								];
					})}
				</div>
			) : (
				<div className="item-actions">
					<button type="button" className="btn primary" onClick={() => draft(`關於「${item.title}」：`)}>
						一起處理
					</button>
					<button type="button" className="btn" onClick={() => act(runs.finishItem(item.id))}>
						已經結束
					</button>
					<button type="button" className="btn" onClick={() => setLater(true)}>
						晚點提醒
					</button>
				</div>
			)}
			{problem ? <p className="item-problem">{problem}</p> : null}
		</>
	);
}
